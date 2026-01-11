"""
Predictive Refill Intelligence Agent
Model: gpt-5.2 ✅ REQUIRED
Purpose: Analyze patient medication history; predict when refills are needed; send proactive reminders
"""
from datetime import datetime
from typing import List
from openai import OpenAI
import os
import json

from models.schemas import RefillPrediction, RefillAction
from utils.langfuse_utils import observe, langfuse_context


REFILL_SYSTEM_PROMPT = """You are a predictive medication refill AI agent.

## YOUR ROLE
Analyze patient medication history and predict when refills are needed.
Provide proactive, helpful recommendations based on:
- Days remaining in current supply
- Patient's medication adherence patterns
- Urgency level of the medication

## REFILL ACTIONS
- REMIND: Send a reminder to the patient (medication running low)
- AUTO_REFILL: Schedule automatic refill (patient opted-in, safe medication)
- BLOCK: Cannot refill without intervention (e.g., prescription expired, controlled substance)

## URGENCY LEVELS
- CRITICAL: Urgent medication (< 0 days remaining)
- HIGH: Needs immediate attention (1-3 days remaining)
- MEDIUM: Action needed soon (4-7 days remaining)
- LOW: Routine reminder (8-14 days remaining)

Be helpful and proactive. Patient adherence to medication is crucial for health outcomes."""


class RefillAgent:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.model = "gpt-5.2" # User requested gpt-5.2
    
    @observe()
    def predict(
        self,
        patient_id: str,
        patient_name: str,
        medication_history: List[dict],
        conversation_history: List[dict] = None
    ) -> List[RefillPrediction]:
        """
        Predict refill needs for a patient based on their medication history
        
        Args:
            patient_id: The patient's ID
            patient_name: The patient's name
            medication_history: List of medication records with days_remaining, etc.
            conversation_history: Previous conversation for context
        
        Returns:
            List of RefillPrediction objects
        """
        langfuse_context.update_current_observation(
            model=self.model, # Log "gpt-5.2" trace
            input={
                "patient_id": patient_id,
                "patient_name": patient_name,
                "medication_count": len(medication_history)
            }
        )
        
        predictions = []
        
        for med in medication_history:
            days_remaining = med.get("days_remaining", 0)
            medicine_name = med.get("medicine", med.get("medicine_name", "Unknown"))
            medicine_id = med.get("medicine_id", "")
            last_purchase = med.get("purchase_date", datetime.now().strftime("%Y-%m-%d"))
            dosage = med.get("dosage", "")
            
            # Determine action and urgency
            if days_remaining <= 0:
                action = RefillAction.BLOCK
                urgency = "CRITICAL"
                justification = f"Medication supply exhausted. {patient_name}'s prescription may need renewal before refill."
            elif days_remaining <= 3:
                action = RefillAction.REMIND
                urgency = "HIGH"
                justification = f"Only {days_remaining} days of supply remaining for {patient_name}. Recommend immediate refill."
            elif days_remaining <= 7:
                action = RefillAction.AUTO_REFILL
                urgency = "MEDIUM"
                justification = f"Running low on supply ({days_remaining} days). Auto-refill scheduled for {patient_name}."
            elif days_remaining <= 14:
                action = RefillAction.REMIND
                urgency = "LOW"
                justification = f"Supply adequate for {days_remaining} days. Reminder sent to {patient_name} for planning."
            else:
                # Don't include medications with plenty of supply
                continue
            
            predictions.append(RefillPrediction(
                patient_id=patient_id,
                patient_name=patient_name,
                medicine=medicine_name,
                medicine_id=medicine_id,
                days_remaining=days_remaining,
                last_purchase_date=last_purchase,
                action=action,
                justification=justification,
                urgency=urgency
            ))
        
        langfuse_context.update_current_observation(
            output={"predictions_count": len(predictions)}
        )
        
        return predictions
    
    @observe()
    def get_all_patient_refills(self, data_service, current_date: datetime) -> List[RefillPrediction]:
        """
        Get refill predictions for all patients
        
        Args:
            data_service: Data service instance
            current_date: Current date for calculations
        
        Returns:
            List of all refill predictions
        """
        all_predictions = []
        patients = data_service.get_all_patients()
        
        for patient in patients:
            medication_history = data_service.get_medicines_needing_refill(
                patient.patient_id,
                current_date
            )
            
            if medication_history:
                predictions = self.predict(
                    patient.patient_id,
                    patient.patient_name,
                    medication_history
                )
                all_predictions.extend(predictions)
        
        # Sort by urgency (CRITICAL first)
        urgency_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        all_predictions.sort(key=lambda x: urgency_order.get(x.urgency, 4))
        
        return all_predictions


# Singleton instance
refill_agent = RefillAgent()
