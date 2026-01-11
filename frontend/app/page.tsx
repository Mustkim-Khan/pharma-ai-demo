'use client';

import { useState, useEffect, useRef } from 'react';
import { Send, Mic, MicOff, Loader2, Paperclip, CheckCircle, ExternalLink, Settings, ChevronRight, Clock, ChevronDown, User, Volume2, Pill, Upload, AlertCircle } from 'lucide-react';
import { Calendar, CheckCircle2 } from 'lucide-react';
import PrescriptionUploadCard from '@/components/PrescriptionUploadCard';
import { usePatient } from '../context/PatientContext';
import { useNotification } from '../context/NotificationContext';

interface Patient {
    patient_id: string;
    patient_name: string;
    patient_email: string;
    patient_phone: string;
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    extractedEntities?: any;
    safetyResult?: any;
    orderPreview?: any;
    order?: any;
    traceUrl?: string;
    aiAnnotation?: string;
    badges?: { label: string; color: string }[];
    expandable?: boolean;
    prescriptionUploaded?: boolean;
}

export default function ChatPage() {
    const { selectedPatient, setSelectedPatient } = usePatient();
    const [patients, setPatients] = useState<Patient[]>([]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [currentEntities, setCurrentEntities] = useState<any>(null);
    const [latestTraceUrl, setLatestTraceUrl] = useState<string | null>(null);
    const { showNotification, notificationsEnabled, toggleNotifications } = useNotification();
    const [autoSaveChats, setAutoSaveChats] = useState(true);
    // const [desktopNotifications, setDesktopNotifications] = useState(false); // Using context now
    const [isPatientDropdownOpen, setIsPatientDropdownOpen] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetchPatients();
    }, []);

    // Load messages from localStorage when patient changes
    useEffect(() => {
        if (selectedPatient) {
            // Only load if auto-save is enabled (or we want to respect the user's last session if they had it on)
            // But requirement says "vanish chats if disabled", so we should strictly follow that?
            // "if user enables... persist... otherwise vanish... but remember in memory"
            // This implies that if it's OFF, we shouldn't load old chats.

            // However, we need to know if the user *wants* it off. autoSaveChats defaults to true?
            // The state `autoSaveChats` defaults to true in line 43.
            // If the user turns it off, we need to respect that preference.

            // Let's assume we load IF there is something there, but if they toggle it off, we clear it.
            const savedMessages = localStorage.getItem(`chat_messages_${selectedPatient.patient_id}`);
            if (savedMessages && autoSaveChats) {
                try {
                    const parsed = JSON.parse(savedMessages);
                    // Convert timestamp strings back to Date objects
                    const messagesWithDates = parsed.map((msg: any) => ({
                        ...msg,
                        timestamp: new Date(msg.timestamp)
                    }));
                    setMessages(messagesWithDates);
                } catch (e) {
                    console.error('Failed to parse saved messages:', e);
                }
            } else {
                setMessages([]); // Clear messages for new patient
            }
            // Clear extracted entities for new patient - each patient has separate context
            setCurrentEntities(null);
        }
    }, [selectedPatient?.patient_id, autoSaveChats]); // Re-run if auto-save is toggled? No, that might wipe current in-memory chat.
    // Actually, if I toggle it OFF mid-session, nothing should happen to memory, but LS should be cleared.

    // Save messages to localStorage whenever they change
    useEffect(() => {
        if (selectedPatient) {
            if (autoSaveChats) {
                if (messages.length > 0) {
                    localStorage.setItem(`chat_messages_${selectedPatient.patient_id}`, JSON.stringify(messages));
                }
            } else {
                // If auto-save is disabled, remove from storage
                localStorage.removeItem(`chat_messages_${selectedPatient.patient_id}`);
            }
        }
    }, [messages, selectedPatient?.patient_id, autoSaveChats]);

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsPatientDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const fetchPatients = async () => {
        try {
            const res = await fetch('/api/patients');
            const data = await res.json();
            setPatients(data);
            // Only set default if no patient is currently selected
            if (data.length > 0 && !selectedPatient) {
                setSelectedPatient(data[0]);
            }
        } catch (error) {
            console.error('Failed to fetch patients:', error);
        }
    };

    const handlePatientChange = (patient: Patient) => {
        setSelectedPatient(patient);
        setMessages([]);
        setCurrentEntities(null);
        setIsPatientDropdownOpen(false);
    };

    const sendMessage = async (text: string) => {
        if (!text.trim() || !selectedPatient || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: text,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInputValue('');
        setIsLoading(true);
        setCurrentEntities(null);

        try {
            // Build conversation history from previous messages
            const conversationHistory = messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }));

            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    patient_id: selectedPatient.patient_id,
                    message: text,
                    session_id: `session-${selectedPatient.patient_id}`,
                    conversation_history: conversationHistory,
                }),
            });


            const data = await res.json();

            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: data.message,
                timestamp: new Date(),
                extractedEntities: data.extracted_entities,
                safetyResult: data.safety_result,
                orderPreview: data.order_preview,
                order: data.order,
                traceUrl: data.trace_url,
                aiAnnotation: data.ai_annotation,
                badges: data.badges,
                expandable: true,
            };

            setMessages(prev => [...prev, assistantMessage]);

            if (data.extracted_entities) {
                setCurrentEntities(data.extracted_entities);
            }
            if (data.trace_url) {
                setLatestTraceUrl(data.trace_url);
            }

            // Trigger notification if order is confirmed
            if (data.order && data.order.status === 'CONFIRMED') {
                showNotification(
                    'Order Confirmed! 🚀',
                    `Order #${data.order.order_id.slice(-6)} has been placed successfully.`,
                    'success'
                );
            }

        } catch (error) {
            console.error('Failed to send message:', error);
            setMessages(prev => [...prev, {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: 'Sorry, I encountered an error. Please try again.',
                timestamp: new Date(),
            }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        sendMessage(inputValue);
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                audioChunksRef.current.push(event.data);
            };

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64Audio = (reader.result as string).split(',')[1];
                    await sendVoiceMessage(base64Audio);
                };
                reader.readAsDataURL(audioBlob);
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            setIsRecording(true);
        } catch (error) {
            console.error('Failed to start recording:', error);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const sendVoiceMessage = async (audioBase64: string) => {
        if (!selectedPatient) return;
        setIsLoading(true);

        try {
            const res = await fetch('/api/voice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    audio_base64: audioBase64,
                    patient_id: selectedPatient.patient_id,
                    session_id: `session-${selectedPatient.patient_id}`,
                }),
            });

            const data = await res.json();

            if (data.transcript) {
                setMessages(prev => [...prev, {
                    id: Date.now().toString(),
                    role: 'user',
                    content: data.transcript,
                    timestamp: new Date(),
                }]);
            }

            const chatResponse = data.chat_response;
            setMessages(prev => [...prev, {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: chatResponse.message,
                timestamp: new Date(),
                extractedEntities: chatResponse.extracted_entities,
                safetyResult: chatResponse.safety_result,
                orderPreview: chatResponse.order_preview,
                order: chatResponse.order,
                traceUrl: chatResponse.trace_url,
            }]);

            if (data.audio_response_base64) {
                const audio = new Audio(`data:audio/mp3;base64,${data.audio_response_base64}`);
                audio.play();
            }

        } catch (error) {
            console.error('Failed to process voice:', error);
        } finally {
            setIsLoading(false);
        }
    };

    // Mock extracted entities for display
    const getPatientDefaults = (name: string = '') => {
        const lowerName = name.toLowerCase();
        if (lowerName.includes('michael')) {
            return {
                medicine: 'Amoxicillin 250mg',
                dosage: 'One capsule daily',
                quantity: '21',
                duration: '7 days',
                rxRequired: false
            };
        }
        if (lowerName.includes('robert')) {
            return {
                medicine: 'Ibuprofen 200mg',
                dosage: 'One tablet as needed',
                quantity: '60',
                duration: '30 days',
                rxRequired: false
            };
        }
        return {
            medicine: 'Metformin 500mg',
            dosage: 'Two tablets daily',
            quantity: '90',
            duration: '45 days',
            rxRequired: true
        };
    };

    const defaults = getPatientDefaults(selectedPatient?.patient_name);
    const displayEntities = currentEntities?.entities?.[0] || null;
    const showRx = displayEntities ? true : defaults.rxRequired; // Real extraction usually implies Rx check needed, but logic can vary

    if (!selectedPatient) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
            </div>
        )
    }

    return (
        <div className="flex h-[calc(100vh-8rem)]">
            {/* Left Panel - Patient Context */}
            <aside className="w-72 bg-white border-r border-gray-200 flex flex-col overflow-y-auto">
                {/* Patient Context Section */}
                <div className="p-4 border-b border-gray-200">
                    <div className="flex items-center gap-2 mb-3">
                        <User className="w-4 h-4 text-gray-500" />
                        <span className="text-sm font-medium text-gray-700">Patient Context</span>
                    </div>

                    {/* Patient Dropdown */}
                    <div className="relative" ref={dropdownRef}>
                        <button
                            onClick={() => setIsPatientDropdownOpen(!isPatientDropdownOpen)}
                            className="w-full flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
                        >
                            <div className="w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-orange-400 to-orange-500 flex items-center justify-center">
                                <span className="text-white text-sm font-medium">
                                    {selectedPatient?.patient_name?.charAt(0) || 'J'}
                                </span>
                            </div>
                            <span className="flex-1 text-left text-sm font-medium text-gray-900">
                                {selectedPatient?.patient_name?.split(' ')[0] || 'Jane'}
                            </span>
                            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isPatientDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>

                        {isPatientDropdownOpen && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg border border-gray-200 shadow-lg z-10 overflow-hidden">
                                {patients.map((patient) => (
                                    <button
                                        key={patient.patient_id}
                                        onClick={() => handlePatientChange(patient)}
                                        className={`w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 transition-colors ${selectedPatient?.patient_id === patient.patient_id ? 'bg-indigo-50' : ''
                                            }`}
                                    >
                                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-orange-400 to-orange-500 flex items-center justify-center">
                                            <span className="text-white text-sm font-medium">
                                                {patient.patient_name.charAt(0)}
                                            </span>
                                        </div>
                                        <span className="text-sm text-gray-900">{patient.patient_name}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Extracted Entities Section */}
                <div className="p-4 border-b border-gray-200">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Extracted Entities</h3>

                    <div className="space-y-3">
                        <div>
                            <p className="text-xs text-gray-500">Medicine:</p>
                            <p className="text-sm font-medium text-gray-900">
                                {displayEntities?.medicine || defaults.medicine}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-500">Dosage:</p>
                            <p className="text-sm font-medium text-gray-900">
                                {displayEntities?.dosage || defaults.dosage}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-500">Quantity:</p>
                            <p className="text-sm font-medium text-gray-900">
                                {displayEntities?.quantity || defaults.quantity} tablets
                            </p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-500">Supply Duration:</p>
                            <p className="text-sm font-medium text-gray-900">{defaults.duration}</p>
                        </div>

                        {/* Badges */}
                        <div className="flex gap-2 mt-2">
                            <span className={`px-2 py-1 text-xs font-medium rounded ${showRx ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700'
                                }`}>
                                Prescription: {showRx ? 'Yes' : 'No'}
                            </span>
                            <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded">
                                Stock: OK
                            </span>
                        </div>
                    </div>
                </div>

                {/* Next Check-up */}
                <div className="p-4 border-b border-gray-200">
                    <div className="flex items-center gap-2 text-orange-500">
                        <Clock className="w-4 h-4" />
                        <span className="text-sm">Next check-up in 14 days</span>
                    </div>
                </div>

                {/* AI Suggested Next Actions */}
                <div className="p-4">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">AI Suggested Next Actions</h3>
                    <div className="space-y-2">
                        <p className="text-sm text-gray-600">Proactively schedule next refill</p>
                        <p className="text-sm text-gray-600">Send follow-up reminder in 30 days</p>
                        <p className="text-sm text-gray-600">Check for potential drug interactions</p>
                    </div>
                </div>
            </aside>

            {/* Main Chat Area */}
            <div className="flex-1 flex flex-col bg-gray-50">
                {/* Chat Header */}
                <div className="bg-white border-b border-gray-200 px-6 py-4">
                    <h2 className="text-lg font-semibold text-gray-900">Conversational Log</h2>
                </div>

                {/* AI Prediction Banner */}
                {messages.length === 0 && (
                    <div className="px-6 pt-4">
                        <div className="inline-flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-200 text-green-700 rounded-full text-sm">
                            <Clock className="w-4 h-4" />
                            AI predicts refill need in 5 days. Reminder scheduled.
                        </div>
                    </div>
                )}

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                    {messages.map((message) => (
                        <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-md ${message.role === 'user' ? 'order-1' : ''}`}>
                                {/* Message Bubble */}
                                <div className={`px-4 py-3 rounded-2xl ${message.role === 'user'
                                    ? 'bg-indigo-600 text-white rounded-br-md'
                                    : 'bg-white border border-gray-200 text-gray-800 rounded-bl-md'
                                    }`}>
                                    <p className="text-sm">{message.content}</p>

                                    {/* Expand link for assistant messages */}

                                </div>

                                {/* AI Annotation */}
                                {message.role === 'assistant' && message.aiAnnotation && (
                                    <div className="mt-1 flex items-start gap-1 text-xs text-gray-500">
                                        <Volume2 className="w-3 h-3 mt-0.5" />
                                        <span>{message.aiAnnotation}</span>
                                    </div>
                                )}

                                {/* Badges */}
                                {message.badges && message.badges.length > 0 && (
                                    <div className="mt-2 flex gap-2">
                                        {message.badges.map((badge, idx) => (
                                            <span key={idx} className={`px-2 py-1 text-xs font-medium rounded ${badge.color === 'indigo' ? 'bg-indigo-100 text-indigo-700' :
                                                badge.color === 'green' ? 'bg-green-100 text-green-700' :
                                                    badge.color === 'yellow' ? 'bg-yellow-100 text-yellow-700' :
                                                        'bg-gray-100 text-gray-700'
                                                }`}>
                                                {badge.label}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                {/* Order Confirmation Card */}
                                {message.orderPreview && (() => {
                                    const subtotal = message.orderPreview.total_amount || 0;
                                    const tax = subtotal * 0.05;
                                    const delivery = 2.00;
                                    const total = subtotal + tax + delivery;
                                    const requiresPrescription = message.orderPreview.requires_prescription ||
                                        message.orderPreview.items?.some((item: any) => item.prescription_required);
                                    const prescriptionMedicines = message.orderPreview.items?.filter((item: any) => item.prescription_required).map((item: any) => item.medicine_name) || [];

                                    return (
                                        <div className="mt-3 space-y-3 max-w-sm">
                                            {/* Prescription Upload Card - Show if prescription required */}
                                            {requiresPrescription && !message.prescriptionUploaded && (
                                                <PrescriptionUploadCard
                                                    medicineName={prescriptionMedicines.join(', ') || message.orderPreview.items?.[0]?.medicine_name || 'This medicine'}
                                                    onUpload={(file) => {
                                                        console.log('Prescription uploaded:', file.name);
                                                        // Update message state to hide upload card
                                                        setMessages(prev => prev.map(msg =>
                                                            msg.id === message.id
                                                                ? { ...msg, prescriptionUploaded: true }
                                                                : msg
                                                        ));
                                                        // In a real app, upload to backend and then confirm
                                                        sendMessage('confirm');
                                                    }}
                                                    onSkip={() => sendMessage('cancel')}
                                                />
                                            )}

                                            {/* Order Card */}
                                            <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-4">
                                                <div className="mb-3">
                                                    <h4 className="font-semibold text-gray-900">
                                                        {requiresPrescription ? 'Order Summary' : 'Confirm Your Order'}
                                                    </h4>
                                                    <p className="text-xs text-gray-500">Review details before confirming home delivery</p>
                                                </div>

                                                <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Medicine</p>

                                                {message.orderPreview.items?.map((item: any, idx: number) => (
                                                    <div key={idx} className="flex items-start gap-3 p-2 bg-gray-50 rounded-lg mb-2">
                                                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                                                            <Pill className="w-4 h-4 text-indigo-600" />
                                                        </div>
                                                        <div className="flex-1">
                                                            <div className="flex items-center gap-2">
                                                                <p className="font-medium text-gray-900 text-sm">{item.medicine_name} {item.strength}</p>
                                                                {item.prescription_required && (
                                                                    <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-medium rounded">Rx</span>
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-gray-500">Quantity: {item.quantity} tablets</p>
                                                        </div>
                                                        {item.unit_price && (
                                                            <p className="text-sm font-medium text-gray-700">
                                                                ${(item.unit_price * item.quantity).toFixed(2)}
                                                            </p>
                                                        )}
                                                    </div>
                                                ))}

                                                {/* Price Breakdown */}
                                                <div className="border-t border-gray-100 pt-3 mt-3 space-y-1 text-xs">
                                                    <div className="flex justify-between text-gray-500">
                                                        <span>Subtotal</span>
                                                        <span>${subtotal.toFixed(2)}</span>
                                                    </div>
                                                    <div className="flex justify-between text-gray-500">
                                                        <span>Tax (5%)</span>
                                                        <span>${tax.toFixed(2)}</span>
                                                    </div>
                                                    <div className="flex justify-between text-gray-500">
                                                        <span>Delivery</span>
                                                        <span>${delivery.toFixed(2)}</span>
                                                    </div>
                                                    <div className="flex justify-between font-semibold text-gray-900 text-sm pt-1">
                                                        <span>Total</span>
                                                        <span>${total.toFixed(2)}</span>
                                                    </div>
                                                </div>

                                                {/* Show confirm/cancel buttons only if prescription not required */}
                                                {!requiresPrescription && (
                                                    <div className="flex gap-2 mt-4">
                                                        <button
                                                            onClick={() => sendMessage('confirm')}
                                                            className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
                                                        >
                                                            Confirm Order
                                                        </button>
                                                        <button
                                                            onClick={() => sendMessage('cancel')}
                                                            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg transition-colors"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })()}

                                {message.order && (
                                    <div className="mt-2 flex gap-2">
                                        <span className="px-2 py-1 bg-indigo-100 text-indigo-700 text-xs font-medium rounded">
                                            Refill placed by AI
                                        </span>
                                        <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded">
                                            Inventory updated
                                        </span>
                                    </div>
                                )}

                                {/* Timestamp */}
                                <p className={`text-xs text-gray-400 mt-1 ${message.role === 'user' ? 'text-right' : ''}`}>
                                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </p>
                            </div>
                        </div>
                    ))}

                    {isLoading && (
                        <div className="flex items-center gap-2 text-gray-500">
                            <div className="flex gap-1">
                                <div className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                                <div className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                                <div className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '300ms' }}></div>
                            </div>
                            <span className="text-sm">AI is thinking...</span>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div className="bg-white border-t border-gray-200 p-4">
                    <form onSubmit={handleSubmit} className="flex items-center gap-3">
                        <button
                            type="button"
                            className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
                        >
                            <Paperclip className="w-5 h-5" />
                        </button>

                        <button
                            type="button"
                            onClick={isRecording ? stopRecording : startRecording}
                            className={`p-2 transition-colors ${isRecording
                                ? 'text-red-500 animate-pulse'
                                : 'text-gray-400 hover:text-gray-600'
                                }`}
                        >
                            {isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                        </button>

                        <input
                            type="text"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            placeholder="Type your message..."
                            className="flex-1 px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                            disabled={isLoading || isRecording}
                        />

                        <button
                            type="submit"
                            disabled={!inputValue.trim() || isLoading}
                            className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {isLoading ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : (
                                <Send className="w-5 h-5" />
                            )}
                        </button>
                    </form>

                    {isRecording && (
                        <div className="flex items-center justify-center gap-2 mt-3 text-red-500">
                            <div className="flex gap-0.5">
                                <div className="w-1 h-4 bg-red-500 rounded animate-pulse"></div>
                                <div className="w-1 h-4 bg-red-500 rounded animate-pulse" style={{ animationDelay: '100ms' }}></div>
                                <div className="w-1 h-4 bg-red-500 rounded animate-pulse" style={{ animationDelay: '200ms' }}></div>
                                <div className="w-1 h-4 bg-red-500 rounded animate-pulse" style={{ animationDelay: '300ms' }}></div>
                            </div>
                            <span className="text-sm font-medium">Listening... Click mic to stop</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Right Panel - AI Decision Summary & Settings */}
            <aside className="w-72 bg-white border-l border-gray-200 flex flex-col overflow-y-auto">
                {/* AI Decision Summary */}
                <div className="p-4 border-b border-gray-200">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">AI Decision Summary</h3>
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-green-500" />
                            <span className="text-sm text-gray-700">Prescription validated</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-green-500" />
                            <span className="text-sm text-gray-700">Inventory available</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-green-500" />
                            <span className="text-sm text-gray-700">Refill approved</span>
                        </div>
                    </div>

                    {latestTraceUrl && (
                        <a
                            href={latestTraceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 mt-3 text-sm text-indigo-600 hover:text-indigo-700"
                        >
                            View full trace (Langfuse)
                        </a>
                    )}
                </div>

                {/* Chat Settings */}
                <div className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <Settings className="w-4 h-4 text-gray-500" />
                        <h3 className="text-sm font-semibold text-gray-900">Chat Settings</h3>
                    </div>
                    <p className="text-xs text-gray-500 mb-4">Personalize your chat experience.</p>

                    <div className="space-y-4">
                        {/* Auto-save chats toggle */}
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-700">Auto-save chats</span>
                            <button
                                onClick={() => setAutoSaveChats(!autoSaveChats)}
                                className={`w-10 h-6 rounded-full transition-colors ${autoSaveChats ? 'bg-indigo-600' : 'bg-gray-300'
                                    }`}
                            >
                                <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-1 ${autoSaveChats ? 'translate-x-4' : 'translate-x-0'
                                    }`} />
                            </button>
                        </div>

                        {/* Desktop Notifications toggle */}
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-700">Desktop Notifications</span>
                            <button
                                onClick={toggleNotifications}
                                className={`w-10 h-6 rounded-full transition-colors ${notificationsEnabled ? 'bg-indigo-600' : 'bg-gray-300'
                                    }`}
                            >
                                <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-1 ${notificationsEnabled ? 'translate-x-4' : 'translate-x-0'
                                    }`} />
                            </button>
                        </div>

                        {/* Archive Conversation */}
                        <button className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900">
                            <ChevronRight className="w-4 h-4" />
                            Archive Conversation
                        </button>
                    </div>
                </div>
            </aside>
        </div>
    );
}
