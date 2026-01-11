'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface Patient {
    patient_id: string;
    patient_name: string;
    patient_email: string;
    patient_phone: string;
}

interface PatientContextType {
    selectedPatient: Patient | null;
    setSelectedPatient: (patient: Patient | null) => void;
    isLoading: boolean;
}

const PatientContext = createContext<PatientContextType | undefined>(undefined);

export function PatientProvider({ children }: { children: ReactNode }) {
    const [selectedPatient, setSelectedPatientState] = useState<Patient | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // Load from localStorage on mount
    useEffect(() => {
        const savedPatient = localStorage.getItem('selected_patient_context');
        if (savedPatient) {
            try {
                setSelectedPatientState(JSON.parse(savedPatient));
            } catch (e) {
                console.error('Failed to parse saved patient context:', e);
            }
        }
        setIsLoading(false);
    }, []);

    // Save to localStorage on change
    const setSelectedPatient = (patient: Patient | null) => {
        setSelectedPatientState(patient);
        if (patient) {
            localStorage.setItem('selected_patient_context', JSON.stringify(patient));
        } else {
            localStorage.removeItem('selected_patient_context');
        }
    };

    return (
        <PatientContext.Provider value={{ selectedPatient, setSelectedPatient, isLoading }}>
            {children}
        </PatientContext.Provider>
    );
}

export function usePatient() {
    const context = useContext(PatientContext);
    if (context === undefined) {
        throw new Error('usePatient must be used within a PatientProvider');
    }
    return context;
}
