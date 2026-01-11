"""
Conversational Extraction Agent
Model: gpt-5-mini
Purpose: Parse messy human input (text/voice) and extract medicine order details with conversation context
"""
import json
from openai import OpenAI
from datetime import datetime
import os
from typing import List

from utils.langfuse_utils import observe, langfuse_context, LANGFUSE_ENABLED
from models.schemas import ExtractedEntity, ExtractionResult


EXTRACTION_SYSTEM_PROMPT = """You are a specialized pharmacy assistant AI designed to extract medicine order details from natural human conversations.

Your task is to parse the user's message and extract structured information about medicine orders.

## CRITICAL: Conversation Context
You will receive the conversation history. Use it to understand:
- What medicine was discussed previously
- When user says "it", "that", "the same", etc., refer to the previous medicine
- Follow-up requests about quantities, dosages for previously mentioned medicines
- Context from earlier in the conversation

## Your Capabilities:
1. Handle messy, conversational input (typos, slang, incomplete sentences)
2. Understand voice transcription artifacts
3. Extract multiple medicines from a single request
4. Recognize common medicine name variations and misspellings
5. **Understand pronouns and references to previous messages** (e.g., "I want 2 of it" = 2 of the previously mentioned medicine)

## What to Extract:
For each medicine mentioned, extract:
- **medicine**: The medicine name (standardize to common name)
- **dosage**: The strength/dosage (e.g., "500mg", "10mg", "100mcg")
- **frequency**: How often they take it (e.g., "once daily", "twice a day", "as needed")
- **quantity**: Number of units requested (tablets, capsules, inhalers, etc.)
- **confidence**: Your confidence in the extraction (0.0 to 1.0)

## Rules:
1. If quantity is not specified, set it to 0 (we'll ask for clarification)
2. If dosage is not specified, leave it empty
3. If multiple medicines are mentioned, extract all of them
4. Normalize medicine names (e.g., "paracetamol" and "acetaminophen" are the same)
5. Handle common abbreviations (OTC, BP meds, sugar tablets = diabetes meds)
6. **If user refers to a previous medicine with "it", "that", "same one", etc., extract that specific medicine from conversation history**

## Output Format:
Respond with a JSON object:
{
  "entities": [
    {
      "medicine": "Metformin",
      "dosage": "500mg",
      "frequency": "twice daily",
      "quantity": 60,
      "confidence": 0.95,
      "raw_text": "the original text mentioning this medicine"
    }
  ],
  "needs_clarification": false,
  "clarification_message": ""
}

If you need clarification (missing quantity, ambiguous medicine), set needs_clarification to true and provide a helpful clarification_message.

## Examples with Context:

Context: User previously asked about Paracetamol
User: "I want 2 tablets of it"
Output: {"entities": [{"medicine": "Paracetamol", "dosage": "", "frequency": "", "quantity": 2, "confidence": 0.95, "raw_text": "2 tablets of it (referring to Paracetamol)"}], "needs_clarification": false, "clarification_message": ""}

Context: User previously discussed Metformin 500mg
User: "Actually make it 30 tablets"
Output: {"entities": [{"medicine": "Metformin", "dosage": "500mg", "frequency": "", "quantity": 30, "confidence": 0.98, "raw_text": "make it 30 tablets (referring to Metformin 500mg)"}], "needs_clarification": false, "clarification_message": ""}

IMPORTANT: Only respond with valid JSON, no additional text."""


class ExtractionAgent:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = "gpt-5-mini" # User requested gpt-5-mini
    
    @observe()
    def extract(self, user_message: str, patient_context: dict = None, conversation_history: List[dict] = None) -> ExtractionResult:
        """
        Extract medicine order details from user message with conversation context
        
        Args:
            user_message: The raw user input (text or transcribed voice)
            patient_context: Optional patient history context
            conversation_history: Previous conversation messages for context
        
        Returns:
            ExtractionResult with extracted entities
        """
        langfuse_context.update_current_observation(
            model=self.model,
            input={
                "user_message": user_message, 
                "patient_context": patient_context,
                "history_length": len(conversation_history or [])
            }
        )
        
        # Build messages array with conversation history
        messages = [{"role": "system", "content": EXTRACTION_SYSTEM_PROMPT}]
        
        # Add patient context as system message if available
        if patient_context and patient_context.get("recent_orders"):
            context_info = f"Patient's recent medication orders: {patient_context['recent_orders']}"
            messages.append({"role": "system", "content": context_info})
        
        # Add conversation history (last 6 messages for extraction context)
        if conversation_history:
            # Add a summary of previous conversation to help with context
            for msg in conversation_history[-6:]:
                messages.append({
                    "role": msg.get("role", "user"),
                    "content": msg.get("content", "")
                })
        
        # Add current message
        messages.append({"role": "user", "content": user_message})
        
        # Map experimental model names to available models
        api_model = "gpt-4o-mini" if "gpt-5" in self.model else self.model
        
        try:
            response = self.client.chat.completions.create(
                model=api_model,
                messages=messages,
                temperature=0.3,
                max_tokens=1000,
                response_format={"type": "json_object"}
            )
            
            result_text = response.choices[0].message.content
            result_data = json.loads(result_text)
            
            # Parse entities
            entities = []
            for entity_data in result_data.get("entities", []):
                entities.append(ExtractedEntity(
                    medicine=entity_data.get("medicine", ""),
                    dosage=entity_data.get("dosage", ""),
                    frequency=entity_data.get("frequency", ""),
                    quantity=entity_data.get("quantity", 0),
                    confidence=entity_data.get("confidence", 0.0),
                    raw_text=entity_data.get("raw_text", "")
                ))
            
            extraction_result = ExtractionResult(
                entities=entities,
                needs_clarification=result_data.get("needs_clarification", False),
                clarification_message=result_data.get("clarification_message", "")
            )
            
            langfuse_context.update_current_observation(
                output=extraction_result.model_dump(),
                usage={
                    "input_tokens": response.usage.prompt_tokens,
                    "output_tokens": response.usage.completion_tokens
                }
            )
            
            return extraction_result
            
        except Exception as e:
            # Log error and return empty result
            langfuse_context.update_current_observation(
                output={"error": str(e)},
                level="ERROR"
            )
            return ExtractionResult(
                entities=[],
                needs_clarification=True,
                clarification_message=f"I had trouble understanding your request. Could you please rephrase it? Error: {str(e)}"
            )


# Singleton instance
extraction_agent = ExtractionAgent()
