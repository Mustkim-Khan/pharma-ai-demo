'use client';

import { PatientProvider } from '../context/PatientContext';
import { NotificationProvider } from '../context/NotificationContext';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <NotificationProvider>
            <PatientProvider>
                {children}
            </PatientProvider>
        </NotificationProvider>
    );
}
