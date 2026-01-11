'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot, Bell, BellOff } from 'lucide-react';
import { useNotification } from '../context/NotificationContext';

const navItems = [
    { href: '/', label: 'Conversational Chat' },
    { href: '/admin', label: 'Admin Inventory Dashboard' },
    { href: '/refills', label: 'Proactive Refill Alerts' },
    { href: '/orders', label: 'Order Confirmation / Details' },
];

export default function Sidebar() {
    const pathname = usePathname();
    const { notificationsEnabled, toggleNotifications } = useNotification();

    return (
        <header className="fixed left-0 top-0 right-0 h-16 bg-white border-b border-gray-200 flex items-center px-6 z-50 justify-between">
            <div className="flex items-center">
                {/* Logo */}
                <div className="flex items-center gap-2 mr-8">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                        <Bot className="w-5 h-5 text-white" />
                    </div>
                    <h1 className="font-semibold text-gray-900">Your Pharma Ai</h1>
                </div>

                {/* Navigation */}
                <nav className="flex items-center gap-1">
                    {navItems.map((item) => {
                        const isActive = pathname === item.href;

                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${isActive
                                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                    }`}
                            >
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-4">
                <button
                    onClick={toggleNotifications}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${notificationsEnabled
                            ? 'bg-green-100 text-green-700 border border-green-200'
                            : 'bg-gray-100 text-gray-500 border border-gray-200 hover:bg-gray-200'
                        }`}
                >
                    {notificationsEnabled ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
                    {notificationsEnabled ? 'Notifications On' : 'Enable Notifications'}
                </button>
            </div>
        </header>
    );
}
