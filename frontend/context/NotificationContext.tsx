'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';
import { CheckCircle2, X } from 'lucide-react';

interface Notification {
    id: string;
    title: string;
    message: string;
    type: 'success' | 'info' | 'error';
}

interface NotificationContextType {
    notificationsEnabled: boolean;
    toggleNotifications: () => void;
    showNotification: (title: string, message: string, type?: 'success' | 'info' | 'error') => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
    const [notificationsEnabled, setNotificationsEnabled] = useState(false);
    const [notification, setNotification] = useState<Notification | null>(null);

    const toggleNotifications = () => {
        setNotificationsEnabled(prev => !prev);
    };

    const showNotification = (title: string, message: string, type: 'success' | 'info' | 'error' = 'success') => {
        if (!notificationsEnabled) return;

        const id = Math.random().toString(36).substring(7);
        setNotification({ id, title, message, type });

        // Auto dismiss after 3 seconds
        setTimeout(() => {
            setNotification(current => current?.id === id ? null : current);
        }, 3000);
    };

    return (
        <NotificationContext.Provider value={{ notificationsEnabled, toggleNotifications, showNotification }}>
            {children}

            {/* Notification Toast */}
            {notification && (
                <div className="fixed bottom-6 right-6 z-[100] animate-slide-up">
                    <div className="bg-white/90 backdrop-blur-md border border-indigo-100 shadow-2xl rounded-2xl p-4 flex items-start gap-4 max-w-sm transform transition-all duration-500 ease-out hover:scale-105">
                        <div className="bg-gradient-to-br from-green-400 to-emerald-600 rounded-full p-2 shadow-lg shadow-green-200">
                            <CheckCircle2 className="w-6 h-6 text-white" />
                        </div>
                        <div className="flex-1">
                            <h4 className="font-bold text-gray-900 text-lg leading-tight">{notification.title}</h4>
                            <p className="text-gray-600 text-sm mt-1">{notification.message}</p>
                        </div>
                        <button
                            onClick={() => setNotification(null)}
                            className="text-gray-400 hover:text-gray-600 transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            )}
        </NotificationContext.Provider>
    );
}

export function useNotification() {
    const context = useContext(NotificationContext);
    if (context === undefined) {
        throw new Error('useNotification must be used within a NotificationProvider');
    }
    return context;
}
