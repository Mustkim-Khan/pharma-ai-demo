"""
Orchestrator Agent
Model: gpt-5.2
Purpose: Coordinate all agents, decide execution order, resolve conflicts, maintain system state
"""
import json
import uuid
from openai import OpenAI
from datetime import datetime
import os

from utils.langfuse_utils import observe, langfuse_context, LANGFUSE_ENABLED, Langfuse

from models.schemas import (
    ChatRequest, ChatResponse, OrderPreview, Order, OrderItem,
    ExtractionResult, SafetyCheckResult, SafetyDecision, RefillPrediction,
    OrderStatus
)
from services.data_service import data_service
from agents.extraction_agent import extraction_agent
from agents.safety_agent import safety_agent
from agents.refill_agent import refill_agent
from agents.fulfillment_agent import fulfillment_agent


ORCHESTRATOR_SYSTEM_PROMPT = """You are an intelligent, conversational AI pharmacist assistant for an autonomous pharmacy system.

## YOUR IDENTITY
You are a professional, helpful pharmacy AI assistant. You maintain a warm, conversational tone while being accurate and efficient.

## CRITICAL: PATIENT CONTEXT AWARENESS
You will receive the ACTUAL patient information from their medical records. This is the SOURCE OF TRUTH:
- The patient's REAL name is provided in the system context
- Their patient ID, order history, and medication records are provided
- If a user claims a DIFFERENT name than what's in the records, politely clarify: "I see you're logged in as [ACTUAL NAME] (Patient ID: [ID]). If this is incorrect, please contact our support team."
- NEVER accept a different identity - the selected patient context is authoritative

## YOUR ROLE
1. Have natural, helpful conversations about medication needs
2. Remember context from previous messages in the conversation
3. Coordinate medication orders, refills, and inquiries
4. Provide PERSONALIZED responses using the patient's actual name
5. Always prioritize patient safety

## Available Actions:
- ORDER: User wants to order medication
- REFILL_CHECK: User asks about refills or medication status
- STATUS_CHECK: User asks about order status
- GENERAL_INQUIRY: General pharmacy questions, greetings, or conversation
- CONFIRM_ORDER: User confirms a pending order (says yes, confirm, ok, etc.)
- CANCEL_ORDER: User cancels a pending order

## For each user message, output:
{
  "intent": "ORDER" | "REFILL_CHECK" | "STATUS_CHECK" | "GENERAL_INQUIRY" | "CONFIRM_ORDER" | "CANCEL_ORDER",
  "confidence": 0.0-1.0,
  "requires_extraction": true/false,
  "requires_safety_check": true/false,
  "response_draft": "Your natural, conversational response. Address the patient BY NAME. Be friendly and helpful.",
  "follow_up_needed": true/false,
  "follow_up_question": ""
}

## CONVERSATION GUIDELINES:
- Address the patient BY THEIR ACTUAL NAME from records
- Be conversational and friendly, like a helpful pharmacist
- Reference previous messages when relevant
- For greetings, warmly introduce yourself: "Hello [Patient Name]! I'm your AI pharmacy assistant..."
- If they claim a different name: "I see from your records that you're [ACTUAL NAME]. Let me assist you today!"
- Always be helpful and safety-focused

IMPORTANT: Your response must be valid JSON only."""


class OrchestratorAgent:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = "gpt-4o" # User requested gpt-5.2
        self.langfuse = Langfuse() if LANGFUSE_ENABLED else None
        self.pending_previews = {}  # Store pending order previews
        self.session_contexts = {}  # Store session contexts
        self.conversation_histories = {}  # Store conversation histories by session
    
    def _generate_preview_id(self) -> str:
        """Generate unique preview ID"""
        return f"PRV-{uuid.uuid4().hex[:8].upper()}"
    
    @observe()
    async def process_message(self, request: ChatRequest) -> ChatResponse:
        """
        Process a user message through the agent pipeline
        
        Args:
            request: ChatRequest with patient_id, message, session_id, conversation_history
        
        Returns:
            ChatResponse with full pipeline results
        """
        # Try to get trace_id if Langfuse is working
        trace_id = None
        try:
            trace = langfuse_context.get_current_trace()
            trace_id = trace.id if trace else None
        except Exception:
            pass  # Langfuse trace not available
        
        # Get patient context
        patient = data_service.get_patient_by_id(request.patient_id)
        if not patient:
            return ChatResponse(
                message="I couldn't find your patient record. Please select a valid patient.",
                trace_url=self._get_trace_url(trace_id)
            )
        
        patient_history = data_service.get_patient_order_history(request.patient_id)
        patient_context = {
            "patient_id": patient.patient_id,
            "patient_name": patient.patient_name,
            "recent_orders": patient_history.tail(5).to_dict('records') if not patient_history.empty else []
        }
        
        # Get conversation history from request (or use stored history as fallback)
        session_id = request.session_id or request.patient_id
        conversation_history = request.conversation_history or self.conversation_histories.get(session_id, [])
        
        # Step 1: Determine intent with conversation context
        intent_result = await self._determine_intent(request.message, patient_context, conversation_history)
        
        # Step 2: Route based on intent
        if intent_result["intent"] == "ORDER":
            return await self._handle_order(request, patient, patient_context, trace_id)
        elif intent_result["intent"] == "REFILL_CHECK":
            return await self._handle_refill_check(request, patient, trace_id)
        elif intent_result["intent"] == "CONFIRM_ORDER":
            return await self._handle_order_confirmation(request, patient, trace_id)
        elif intent_result["intent"] == "CANCEL_ORDER":
            return await self._handle_order_cancellation(request, trace_id)
        elif intent_result["intent"] == "STATUS_CHECK":
            return await self._handle_status_check(request, trace_id)
        else:
            return ChatResponse(
                message=intent_result.get("response_draft", "How can I help you with your pharmacy needs today?"),
                trace_url=self._get_trace_url(trace_id)

            )
    
    @observe()
    async def _determine_intent(self, message: str, patient_context: dict, conversation_history: list = None) -> dict:
        """Determine user intent from message with conversation context"""
        langfuse_context.update_current_observation(
            model=self.model,
            input={"message": message, "patient_context": patient_context, "history_length": len(conversation_history or [])}
        )
        
        # Build messages array with conversation history
        messages = [{"role": "system", "content": ORCHESTRATOR_SYSTEM_PROMPT}]
        
        # Add patient context as system message
        patient_info = f"""Current Patient Information:
- Name: {patient_context.get('patient_name', 'Unknown')}
- ID: {patient_context.get('patient_id', 'N/A')}
- Recent Orders: {len(patient_context.get('recent_orders', []))} orders on file"""
        messages.append({"role": "system", "content": patient_info})
        
        # Add conversation history (last 10 messages for context)
        if conversation_history:
            for msg in conversation_history[-10:]:
                messages.append({
                    "role": msg.get("role", "user"),
                    "content": msg.get("content", "")
                })
        
        # Add current user message
        messages.append({"role": "user", "content": message})
        
        # Map experimental model names to available models
        api_model = "gpt-4o" if "gpt-5" in self.model else self.model
        
        try:
            response = self.client.chat.completions.create(
                model=api_model,
                messages=messages,
                temperature=0.7,  # More creative for natural conversation
                max_tokens=800,
                response_format={"type": "json_object"}
            )
            
            result = json.loads(response.choices[0].message.content)
            
            langfuse_context.update_current_observation(
                output=result,
                usage={
                    "input_tokens": response.usage.prompt_tokens,
                    "output_tokens": response.usage.completion_tokens
                }
            )
            
            return result
            
        except Exception as e:
            return {"intent": "GENERAL_INQUIRY", "confidence": 0.5, "response_draft": f"I apologize, I encountered an issue. How can I help you today? (Error: {str(e)})"}
    
    async def _handle_order(self, request: ChatRequest, patient, patient_context: dict, trace_id: str) -> ChatResponse:
        """Handle medication order requests"""
        
        # Step 1: Extract entities with conversation history for context
        extraction_result = extraction_agent.extract(
            request.message, 
            patient_context,
            request.conversation_history  # Pass conversation history for context
        )
        
        if extraction_result.needs_clarification:
            return ChatResponse(
                message=extraction_result.clarification_message,
                extracted_entities=extraction_result,
                trace_url=self._get_trace_url(trace_id)
            )
        
        if not extraction_result.entities:
            return ChatResponse(
                message="I couldn't identify any medications in your request. Could you please specify which medicine you need?",
                extracted_entities=extraction_result,
                trace_url=self._get_trace_url(trace_id)
            )
        
        # Step 2: Find matching medicines
        matched_medicines = []
        for entity in extraction_result.entities:
            search_results = data_service.search_medicine(entity.medicine)
            if search_results:
                # Find best match considering dosage
                for med in search_results:
                    if not entity.dosage or entity.dosage.lower() in med.strength.lower():
                        matched_medicines.append(med)
                        break
                else:
                    matched_medicines.append(search_results[0])
        
        if not matched_medicines:
            return ChatResponse(
                message=f"I couldn't find '{extraction_result.entities[0].medicine}' in our inventory. Please check the spelling or try a different medication.",
                extracted_entities=extraction_result,
                trace_url=self._get_trace_url(trace_id)
            )
        
        # Step 3: Safety check with full context
        safety_result = safety_agent.evaluate(
            extraction_result.entities,
            matched_medicines,
            has_prescription=False,  # Will be updated based on patient records
            patient_context=patient_context,
            conversation_history=request.conversation_history
        )
        
        # Create order preview
        if safety_result.decision == SafetyDecision.REJECT:
            return ChatResponse(
                message=f"I'm sorry, but I cannot process this order. {' '.join(safety_result.reasons)}",
                extracted_entities=extraction_result,
                safety_result=safety_result,
                trace_url=self._get_trace_url(trace_id)
            )
        
        # Step 4: Create order preview
        preview_id = self._generate_preview_id()
        items = []
        
        for i, entity in enumerate(extraction_result.entities):
            if i < len(matched_medicines):
                med = matched_medicines[i]
                quantity = entity.quantity if entity.quantity > 0 else 30  # Default quantity
                if safety_result.allowed_quantity:
                    quantity = min(quantity, safety_result.allowed_quantity)
                
                items.append(OrderItem(
                    medicine_id=med.medicine_id,
                    medicine_name=med.medicine_name,
                    strength=med.strength,
                    quantity=quantity,
                    prescription_required=med.prescription_required
                ))
        # Price map for calculating actual prices (same as fulfillment_agent)
        price_map = {
            "Paracetamol": 0.15,
            "Metformin": 0.20,
            "Atorvastatin": 0.85,
            "Lisinopril": 0.55,
            "Amlodipine": 0.65,
            "Omeprazole": 0.40,
            "Amoxicillin": 0.35,
            "Ibuprofen": 0.20,
            "Aspirin": 0.10,
        }
        
        # Set actual prices on items
        for item in items:
            item.unit_price = price_map.get(item.medicine_name, 0.50)
        
        subtotal = sum(item.unit_price * item.quantity for item in items)
        
        preview = OrderPreview(
            preview_id=preview_id,
            patient_id=patient.patient_id,
            patient_name=patient.patient_name,
            items=items,
            total_amount=round(subtotal, 2),
            safety_decision=safety_result.decision,
            safety_reasons=safety_result.reasons,
            requires_prescription=safety_result.requires_prescription,
            created_at=datetime.now()
        )
        
        # Store preview for confirmation
        self.pending_previews[preview_id] = preview
        self.session_contexts[request.session_id or request.patient_id] = preview_id
        
        # Build response message
        items_summary = ", ".join([f"{item.medicine_name} {item.strength} x{item.quantity}" for item in items])
        
        if safety_result.decision == SafetyDecision.CONDITIONAL:
            message = f"I can prepare your order for {items_summary}. However: {' '.join(safety_result.reasons)}\n\nWould you like to proceed? Reply 'confirm' to place the order or 'cancel' to cancel."
        else:
            message = f"Great! I've prepared your order for {items_summary}.\n\nEstimated total: ${preview.total_amount:.2f}\n\nPlease reply 'confirm' to place the order or 'cancel' to cancel."
        
        return ChatResponse(
            message=message,
            extracted_entities=extraction_result,
            safety_result=safety_result,
            order_preview=preview,
            requires_confirmation=True,
            trace_url=self._get_trace_url(trace_id)
        )
    
    async def _handle_order_confirmation(self, request: ChatRequest, patient, trace_id: str) -> ChatResponse:
        """Handle order confirmation"""
        session_id = request.session_id or request.patient_id
        preview_id = self.session_contexts.get(session_id)
        
        if not preview_id or preview_id not in self.pending_previews:
            return ChatResponse(
                message="I don't see any pending order to confirm. Would you like to place a new order?",
                trace_url=self._get_trace_url(trace_id)
            )
        
        preview = self.pending_previews[preview_id]
        
        # Create the actual order
        order = fulfillment_agent.create_order(
            patient_id=patient.patient_id,
            patient_name=patient.patient_name,
            patient_email=patient.patient_email,
            patient_phone=patient.patient_phone,
            items=preview.items
        )
        
        # Step 1: Record safety validation and update to VALIDATED status
        fulfillment_agent.record_safety_validation(
            order.order_id, 
            preview.safety_decision.value if hasattr(preview.safety_decision, 'value') else preview.safety_decision, 
            preview.safety_reasons
        )
        fulfillment_agent.update_order_status(order.order_id, OrderStatus.VALIDATED, "Safety validation completed")
        
        # Step 2: Record order confirmation and update to CONFIRMED status
        fulfillment_agent.record_order_confirmed(order.order_id)
        fulfillment_agent.update_order_status(order.order_id, OrderStatus.CONFIRMED, "Order confirmed by patient")
        
        # Step 3: Update inventory and record event
        total_quantity = 0
        for item in order.items:
            data_service.update_stock(item.medicine_id, item.quantity)
            total_quantity += item.quantity
        
        fulfillment_agent.record_inventory_updated(order.order_id, total_quantity)
        
        # Step 4: Record fulfillment initiated and update to PROCESSING status  
        fulfillment_agent.record_fulfillment_initiated(order.order_id)
        fulfillment_agent.update_order_status(order.order_id, OrderStatus.PROCESSING, "Order is being processed for delivery")
        
        # Trigger mock warehouse webhook
        await fulfillment_agent.trigger_warehouse_webhook(order)
        
        # Add to order history
        for item in order.items:
            data_service.add_order({
                "order_id": order.order_id,
                "patient_id": patient.patient_id,
                "patient_name": patient.patient_name,
                "patient_email": patient.patient_email,
                "patient_phone": patient.patient_phone,
                "medicine": item.medicine_name,
                "medicine_id": item.medicine_id,
                "dosage": item.strength,
                "quantity": item.quantity,
                "purchase_date": datetime.now().strftime("%Y-%m-%d"),
                "supply_days": 30,
                "prescription_id": order.prescription_id or "null",
                "order_status": "PROCESSING"
            })
        
        # Generate receipt
        receipt = fulfillment_agent.generate_receipt(order)
        
        # Send notifications (Email/WhatsApp)
        await fulfillment_agent.send_receipt_notification(receipt)
        
        # Clean up preview
        del self.pending_previews[preview_id]
        if session_id in self.session_contexts:
            del self.session_contexts[session_id]
        
        items_summary = ", ".join([f"{item.medicine_name} {item.strength} x{item.quantity}" for item in order.items])
        
        # Calculate grand total (same as frontend: subtotal + 5% tax + $2 delivery)
        tax = order.total_amount * 0.05
        delivery = 2.00
        grand_total = order.total_amount + tax + delivery
        
        message = f"""✅ **Order Confirmed!**

**Order ID:** {order.order_id}
**Items:** {items_summary}
**Subtotal:** ${order.total_amount:.2f}
**Tax (5%):** ${tax:.2f}
**Delivery:** ${delivery:.2f}
**Total:** ${grand_total:.2f}

**Receipt #:** {receipt.get('receipt_number', 'N/A')}

{receipt.get('thank_you_message', 'Thank you for your order!')}

Your order is now being prepared for delivery."""
        
        return ChatResponse(
            message=message,
            order=order,
            trace_url=self._get_trace_url(trace_id)
        )
    
    async def _handle_order_cancellation(self, request: ChatRequest, trace_id: str) -> ChatResponse:
        """Handle order cancellation"""
        session_id = request.session_id or request.patient_id
        preview_id = self.session_contexts.get(session_id)
        
        if preview_id and preview_id in self.pending_previews:
            del self.pending_previews[preview_id]
        if session_id in self.session_contexts:
            del self.session_contexts[session_id]
        
        return ChatResponse(
            message="Your order has been cancelled. Is there anything else I can help you with?",
            trace_url=self._get_trace_url(trace_id)
        )
    
    async def _handle_refill_check(self, request: ChatRequest, patient, trace_id: str) -> ChatResponse:
        """Handle refill check requests"""
        medication_history = data_service.get_medicines_needing_refill(
            patient.patient_id,
            datetime.now()
        )
        
        if not medication_history:
            return ChatResponse(
                message=f"Hi {patient.patient_name}! I checked your medication history, and you don't have any refills due at the moment. All your medications should be well-stocked.",
                trace_url=self._get_trace_url(trace_id)
            )
        
        predictions = refill_agent.predict(
            patient.patient_id,
            patient.patient_name,
            medication_history
        )
        
        if not predictions:
            return ChatResponse(
                message=f"Hi {patient.patient_name}! Your medications are all looking good - no urgent refills needed right now.",
                trace_url=self._get_trace_url(trace_id)
            )
        
        # Build response
        refill_messages = []
        for pred in predictions:
            status = f"**{pred.medicine}**: {pred.days_remaining} days remaining"
            if pred.action == "REMIND":
                status += " ⚠️ (refill soon)"
            elif pred.action == "AUTO_REFILL":
                status += " 🔄 (auto-refill eligible)"
            elif pred.action == "BLOCK":
                status += " ❌ (action required)"
            refill_messages.append(status)
        
        message = f"Hi {patient.patient_name}! Here's your medication refill status:\n\n" + "\n".join(refill_messages)
        
        if any(p.action == "REMIND" for p in predictions):
            message += "\n\nWould you like me to prepare a refill order for any of these?"
        
        return ChatResponse(
            message=message,
            refill_suggestions=predictions,
            trace_url=self._get_trace_url(trace_id)
        )
    
    async def _handle_status_check(self, request: ChatRequest, trace_id: str) -> ChatResponse:
        """Handle order status check"""
        orders = fulfillment_agent.get_all_orders()
        patient_orders = [o for o in orders if o.patient_id == request.patient_id]
        
        if not patient_orders:
            return ChatResponse(
                message="You don't have any recent orders. Would you like to place a new order?",
                trace_url=self._get_trace_url(trace_id)
            )
        
        latest = patient_orders[-1]
        items_summary = ", ".join([f"{item.medicine_name} x{item.quantity}" for item in latest.items])
        
        status_emoji = {
            "PENDING": "⏳",
            "CONFIRMED": "✅",
            "PREPARING": "📦",
            "PROCESSING": "🚚",
            "COMPLETED": "✔️",
            "CANCELLED": "❌"
        }
        
        message = f"""**Order Status: {latest.order_id}**

{status_emoji.get(latest.status.value, '📋')} Status: {latest.status.value}
📋 Items: {items_summary}
💰 Total: ${latest.total_amount:.2f}
📅 Ordered: {latest.created_at.strftime('%Y-%m-%d %H:%M')}
"""
        
        return ChatResponse(
            message=message,
            order=latest,
            trace_url=self._get_trace_url(trace_id)
        )
    
    def _get_trace_url(self, trace_id: str) -> str:
        """Generate Langfuse trace URL"""
        if not trace_id:
            return None
        host = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com")
        return f"{host}/trace/{trace_id}"


# Singleton instance
orchestrator_agent = OrchestratorAgent()
