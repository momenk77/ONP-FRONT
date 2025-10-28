/**
 * Enhanced Chat Engine - Standalone module for robust chat functionality
 * Handles WebSocket connections, message queuing, error handling, and optimistic updates
 * Version 2.0 - Improved instructor resolution and backend integration
 */

class ChatEngine {
    constructor(config = {}) {
        this.config = {
            apiBase: config.apiBase || 'https://mazengad6-001-site1.rtempurl.com/api/Chat',
            wsBase: config.wsBase || 'wss://mazengad6-001-site1.rtempurl.com/ws/chat',
            userApiBase: config.userApiBase || 'https://mazengad6-001-site1.rtempurl.com/api',
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 500,
            pollInterval: config.pollInterval || 3000,
            ...config
        };

        // State management
        this.conversations = [];
        this.currentConversation = null;
        this.messageQueue = new Map();
        this.inFlightSends = new Set();
        this.userCache = new Map(); // Cache for user lookups
        this.courseCache = new Map(); // Cache for course data

        // Connection management
        this.ws = null;
        this.reconnectAttempts = 0;
        this.pollTimer = null;
        this.isConnected = false;

        // Event handlers
        this.eventHandlers = {
            messageReceived: [],
            messageSent: [],
            messageError: [],
            connectionChanged: [],
            conversationChanged: []
        };

        this.init();
    }

    init() {
        this.connectWebSocket();
        this.setupPeriodicSync();
    }

    // Event system
    on(event, handler) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event].push(handler);
        }
    }

    emit(event, data) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event].forEach(handler => handler(data));
        }
    }

    // Authentication helpers
    getToken() {
        return localStorage.getItem('token') || null;
    }

    getUser() {
        try {
            return JSON.parse(localStorage.getItem('user') || 'null');
        } catch {
            return null;
        }
    }

    getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        const token = this.getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    // Enhanced WebSocket connection with better error handling
    async connectWebSocket() {
        try {
            const token = this.getToken();
            if (!token) {
                console.log('No token available for WebSocket connection');
                this.emit('connectionChanged', { status: 'no-auth', message: 'Authentication required' });
                return;
            }

            console.log('Attempting WebSocket connection...');
            this.ws = new WebSocket(`${this.config.wsBase}?token=${encodeURIComponent(token)}`);

            this.ws.onopen = () => {
                console.log('✅ WebSocket connected successfully');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.emit('connectionChanged', { status: 'connected', message: 'WebSocket Connected' });
                this.sendQueuedMessages();
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleWebSocketMessage(data);
                } catch (err) {
                    console.error('WebSocket message parse error:', err);
                }
            };

            this.ws.onclose = (event) => {
                console.log('WebSocket disconnected, code:', event.code);
                this.isConnected = false;
                this.emit('connectionChanged', { status: 'disconnected', message: 'WebSocket Disconnected - Using REST' });

                if (event.code !== 1000) { // Not a normal closure
                    this.scheduleReconnect();
                }
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.isConnected = false;
                this.emit('connectionChanged', { status: 'error', message: 'WebSocket Failed - Using REST Only' });
            };

            // Connection timeout
            setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                    console.warn('WebSocket connection timeout');
                    this.ws.close();
                    this.emit('connectionChanged', { status: 'timeout', message: 'WebSocket Timeout - Using REST Only' });
                }
            }, 10000);

        } catch (error) {
            console.warn('WebSocket connection failed, using REST only:', error);
            this.emit('connectionChanged', { status: 'rest-only', message: 'WebSocket Not Available - Using REST Only' });
        }
    }

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.config.maxRetries) {
            console.error('Max WebSocket reconnection attempts reached');
            return;
        }

        const delay = this.config.retryDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 250;
        setTimeout(() => {
            this.reconnectAttempts++;
            this.connectWebSocket();
        }, Math.min(delay, 30000));
    }

    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'message':
                this.handleIncomingMessage(data.payload);
                break;
            case 'ack':
                this.handleMessageAck(data.payload);
                break;
            case 'typing':
                this.handleTypingIndicator(data.payload);
                break;
            case 'user_status':
                this.handleUserStatus(data.payload);
                break;
            default:
                console.warn('Unknown WebSocket message type:', data.type);
        }
    }

    // Enhanced conversation loading with caching
    async loadConversations(forceRefresh = false) {
        if (!forceRefresh && this.conversations.length > 0) {
            return this.conversations;
        }

        try {
            const res = await fetch(`${this.config.apiBase}/conversations`, {
                headers: this.getHeaders()
            });

            if (!res.ok) {
                throw new Error(`Failed to fetch conversations: ${res.status} ${res.statusText}`);
            }

            this.conversations = await res.json();

            // Cache user and course data from conversations
            this.conversations.forEach(conv => {
                if (conv.otherUserId && conv.otherUserName) {
                    this.userCache.set(conv.otherUserId, {
                        id: conv.otherUserId,
                        name: conv.otherUserName,
                        profileImage: conv.otherUserProfileImage
                    });
                }

                if (conv.courseId && conv.courseTitle) {
                    this.courseCache.set(conv.courseId, {
                        id: conv.courseId,
                        title: conv.courseTitle
                    });
                }
            });

            return this.conversations;
        } catch (error) {
            console.error('Error loading conversations:', error);
            throw error;
        }
    }

    // Enhanced message loading with better error handling
    async loadMessages(otherUserId, courseId, markRead = true) {
        try {
            const res = await fetch(
                `${this.config.apiBase}/messages/${encodeURIComponent(otherUserId)}/${encodeURIComponent(courseId)}`,
                { headers: this.getHeaders() }
            );

            if (!res.ok) {
                throw new Error(`Failed to fetch messages: ${res.status} ${res.statusText}`);
            }

            const messages = await res.json();

            // Auto-mark as read if requested
            if (markRead && Array.isArray(messages)) {
                const unreadMessages = messages.filter(m => !m.isRead && !m.isFromCurrentUser);
                if (unreadMessages.length > 0) {
                    // Mark messages as read in background
                    this.markMessagesAsRead(unreadMessages.map(m => m.id)).catch(console.error);
                }
            }

            return messages;
        } catch (error) {
            console.error('Error loading messages:', error);
            throw error;
        }
    }

    // Enhanced user resolution with multiple strategies
    async resolveUser(identifier, courseId = null) {
        console.log(`🔍 Resolving user: "${identifier}", courseId: ${courseId}`);

        // Check cache first
        if (this.userCache.has(identifier)) {
            const cached = this.userCache.get(identifier);
            console.log(`✅ Found cached user:`, cached);
            return cached;
        }

        // Strategy 1: Direct user ID (numeric)
        if (typeof identifier === 'string' && identifier.match(/^\d+$/)) {
            const user = { id: identifier, name: `User ${identifier}`, resolved: true };
            this.userCache.set(identifier, user);
            console.log(`✅ Using direct user ID:`, user);
            return user;
        }

        // Strategy 2: Try multiple user lookup endpoints FIRST (most reliable)
        console.log(`🔍 Trying API lookup for: "${identifier}"`);
        const resolvedUser = await this.findUserByName(identifier);
        if (resolvedUser && resolvedUser.id) {
            this.userCache.set(identifier, resolvedUser);
            this.userCache.set(resolvedUser.id, resolvedUser);
            console.log(`✅ Found user via API lookup:`, resolvedUser);
            return resolvedUser;
        }

        // Strategy 3: Check existing conversations for this user name
        try {
            console.log(`🔍 Checking existing conversations...`);
            const conversations = await this.loadConversations();
            const existingConv = conversations.find(c =>
                c.otherUserName && (
                    c.otherUserName === identifier ||
                    c.otherUserName.toLowerCase() === identifier.toLowerCase()
                )
            );
            if (existingConv) {
                const user = {
                    id: existingConv.otherUserId,
                    name: existingConv.otherUserName,
                    resolved: true
                };
                this.userCache.set(identifier, user);
                this.userCache.set(user.id, user);
                console.log(`✅ Found user from existing conversations:`, user);
                return user;
            }
        } catch (error) {
            console.log('❌ Could not check existing conversations:', error.message);
        }

        // Strategy 4: Course-based instructor lookup
        if (courseId) {
            console.log(`🔍 Trying course-based instructor lookup for course ${courseId}...`);
            const instructor = await this.findCourseInstructor(courseId);
            if (instructor && instructor.id) {
                this.userCache.set(identifier, instructor);
                this.userCache.set(instructor.id, instructor);
                console.log(`✅ Found instructor via course lookup:`, instructor);
                return instructor;
            }
        }

        // Strategy 5: If all else fails, throw an error instead of using unresolved format
        console.error(`❌ Could not resolve user: "${identifier}"`);
        throw new Error(`User not found: "${identifier}". Please check if this user exists in the system.`);
    }

    // Multiple user lookup strategies
    async findUserByName(name, role = null) {
        console.log(`🔍 Looking up user by name: "${name}", role: ${role}`);

        const lookupStrategies = [
            // Strategy 1: Admin users endpoint (most comprehensive)
            async () => {
                try {
                    console.log(`📡 Trying Admin/GetUsers endpoint...`);
                    const res = await fetch(
                        `${this.config.userApiBase}/Admin/GetUsers`,
                        { headers: this.getHeaders() }
                    );

                    if (res.ok) {
                        const users = await res.json();
                        console.log(`📊 Found ${users.length} users from admin endpoint`);

                        // Log first few users for debugging
                        console.log(`👥 Sample users:`, users.slice(0, 3).map(u => ({
                            id: u.id || u.userId,
                            fullName: u.fullName,
                            name: u.name,
                            userName: u.userName
                        })));

                        // Try exact match first
                        let user = users.find(u => {
                            const fullName = (u.fullName || '').toLowerCase();
                            const userName = (u.userName || '').toLowerCase();
                            const displayName = (u.name || '').toLowerCase();
                            const searchName = name.toLowerCase();

                            return fullName === searchName ||
                                userName === searchName ||
                                displayName === searchName;
                        });

                        // If no exact match, try partial match
                        if (!user) {
                            user = users.find(u => {
                                const fullName = (u.fullName || '').toLowerCase();
                                const userName = (u.userName || '').toLowerCase();
                                const displayName = (u.name || '').toLowerCase();
                                const searchName = name.toLowerCase();

                                return fullName.includes(searchName) ||
                                    userName.includes(searchName) ||
                                    displayName.includes(searchName) ||
                                    searchName.includes(fullName) ||
                                    searchName.includes(userName) ||
                                    searchName.includes(displayName);
                            });
                        }

                        if (user) {
                            const resolvedUser = {
                                id: String(user.id || user.userId),
                                name: user.fullName || user.name || user.userName || name,
                                email: user.email,
                                profileImage: user.profileImage,
                                resolved: true
                            };
                            console.log(`✅ Found user via admin endpoint:`, resolvedUser);
                            return resolvedUser;
                        } else {
                            console.log(`❌ No user found matching "${name}" in ${users.length} users`);
                        }
                    } else {
                        console.log(`❌ Admin endpoint failed: ${res.status} ${res.statusText}`);
                    }
                } catch (error) {
                    console.log('❌ Admin endpoint error:', error.message);
                }
                return null;
            },

            // Strategy 2: Direct user lookup endpoint
            async () => {
                try {
                    console.log(`📡 Trying User/lookup endpoint...`);
                    const res = await fetch(
                        `${this.config.userApiBase}/User/lookup?name=${encodeURIComponent(name)}${role ? `&role=${role}` : ''}`,
                        { headers: this.getHeaders() }
                    );
                    if (res.ok) {
                        const userData = await res.json();
                        console.log(`✅ Found user via lookup endpoint:`, userData);
                        return {
                            id: String(userData.id || userData.userId),
                            name: userData.fullName || userData.name || name,
                            email: userData.email,
                            profileImage: userData.profileImage,
                            resolved: true
                        };
                    } else {
                        console.log(`❌ User lookup failed: ${res.status} ${res.statusText}`);
                    }
                } catch (error) {
                    console.log('❌ User lookup endpoint error:', error.message);
                }
                return null;
            },

            // Strategy 3: Search through existing conversations
            async () => {
                try {
                    console.log(`📡 Searching existing conversations...`);
                    const conversations = await this.loadConversations();
                    const conv = conversations.find(c =>
                        c.otherUserName && c.otherUserName.toLowerCase() === name.toLowerCase()
                    );
                    if (conv) {
                        console.log(`✅ Found user via existing conversations:`, conv);
                        return {
                            id: String(conv.otherUserId),
                            name: conv.otherUserName,
                            profileImage: conv.otherUserProfileImage,
                            resolved: true
                        };
                    } else {
                        console.log(`❌ No matching conversation found for "${name}"`);
                    }
                } catch (error) {
                    console.log('❌ Could not search conversations:', error.message);
                }
                return null;
            }
        ];

        // Try each strategy until one succeeds
        for (let i = 0; i < lookupStrategies.length; i++) {
            try {
                console.log(`🔄 Trying lookup strategy ${i + 1}/3...`);
                const result = await lookupStrategies[i]();
                if (result && result.id) {
                    console.log(`✅ Strategy ${i + 1} succeeded:`, result);
                    return result;
                }
            } catch (error) {
                console.error(`❌ User lookup strategy ${i + 1} failed:`, error);
            }
        }

        console.log(`❌ All lookup strategies failed for: "${name}"`);
        return null;
    }

    async findCourseInstructor(courseId) {
        try {
            // Try to get course details
            const res = await fetch(
                `${this.config.userApiBase}/Course/${courseId}`,
                { headers: this.getHeaders() }
            );

            if (res.ok) {
                const course = await res.json();
                if (course.instructorId) {
                    return await this.resolveUser(course.instructorId);
                }
                if (course.instructorName) {
                    return await this.findUserByName(course.instructorName, 'Instructor');
                }
            }
        } catch (error) {
            console.error('Error finding course instructor:', error);
        }
        return null;
    }

    // Enhanced message sending with better error handling
    async sendMessage(receiverId, courseId, content, messageId = null) {
        if (!messageId) {
            messageId = this.generateMessageId();
        }

        console.log(`📤 Sending message - receiverId: "${receiverId}", courseId: ${courseId}`);

        try {
            // Resolve receiver if needed
            const receiver = await this.resolveUser(receiverId, courseId);
            console.log(`✅ Resolved receiver:`, receiver);

            if (!receiver || !receiver.id) {
                throw new Error(`Could not resolve receiver: ${receiverId}`);
            }

            const actualReceiverId = receiver.id;
            console.log(`📤 Using receiver ID: "${actualReceiverId}"`);

            const message = {
                id: messageId,
                content: content,
                receiverId: actualReceiverId,
                courseId: Number(courseId),
                status: 'pending',
                timestamp: Date.now(),
                retryCount: 0,
                isFromCurrentUser: true
            };

            // Store in queue for status tracking
            this.messageQueue.set(messageId, message);
            this.inFlightSends.add(messageId);

            // Emit optimistic update
            this.emit('messageSent', { message, optimistic: true });

            try {
                await this.sendMessageToServer(message);
            } catch (error) {
                this.handleSendError(messageId, error);
                throw error; // Re-throw to let caller handle it
            }

            return messageId;
        } catch (error) {
            console.error(`❌ Send message failed:`, error);
            // Remove from tracking if resolution failed
            this.messageQueue.delete(messageId);
            this.inFlightSends.delete(messageId);
            throw error;
        }
    }

    async sendMessageToServer(message) {
        const payload = {
            receiverId: message.receiverId,
            courseId: message.courseId,
            content: message.content,
            messageId: message.id
        };

        // Try WebSocket first
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.sendViaWebSocket(message);
            return;
        }

        // Fallback to REST
        const res = await fetch(`${this.config.apiBase}/send-message`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errorText}`);
        }

        const data = await res.json();
        this.handleMessageAck({
            messageId: message.id,
            serverTimestamp: data.timestamp || Date.now()
        });
    }

    sendViaWebSocket(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.ws.send(JSON.stringify({
            type: 'send',
            payload: {
                receiverId: message.receiverId,
                courseId: message.courseId,
                content: message.content,
                messageId: message.id
            }
        }));
    }

    handleMessageAck(data) {
        const message = this.messageQueue.get(data.messageId);
        if (message) {
            message.status = 'sent';
            message.serverTimestamp = data.serverTimestamp;
            this.inFlightSends.delete(data.messageId);
            this.emit('messageSent', { message, optimistic: false });
        }
    }

    handleSendError(messageId, error) {
        const message = this.messageQueue.get(messageId);
        if (!message) return;

        this.inFlightSends.delete(messageId);

        if (this.isRetryableError(error) && message.retryCount < this.config.maxRetries) {
            message.retryCount++;
            message.status = 'retrying';
            this.emit('messageError', { messageId, status: 'retrying', error });

            const delay = this.config.retryDelay * Math.pow(2, message.retryCount - 1) + Math.random() * 250;
            setTimeout(() => this.retryMessage(messageId), Math.min(delay, 30000));
        } else {
            message.status = 'failed';
            message.error = error.message;
            this.emit('messageError', { messageId, status: 'failed', error });
        }
    }

    async retryMessage(messageId) {
        const message = this.messageQueue.get(messageId);
        if (!message || message.status !== 'retrying') return;

        message.status = 'pending';
        this.inFlightSends.add(messageId);
        this.emit('messageError', { messageId, status: 'pending' });

        try {
            await this.sendMessageToServer(message);
        } catch (error) {
            this.handleSendError(messageId, error);
        }
    }

    isRetryableError(error) {
        return error.name === 'TypeError' ||
            error.message.includes('fetch') ||
            error.message.includes('network') ||
            (error.status >= 500 && error.status < 600);
    }

    handleIncomingMessage(messageData) {
        this.emit('messageReceived', messageData);
    }

    // Utility methods
    generateMessageId() {
        return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    async markMessagesAsRead(messageIds) {
        if (!Array.isArray(messageIds) || messageIds.length === 0) return;

        try {
            const promises = messageIds.map(id =>
                fetch(`${this.config.apiBase}/mark-as-read`, {
                    method: 'POST',
                    headers: this.getHeaders(),
                    body: JSON.stringify({ messageId: id })
                })
            );

            await Promise.allSettled(promises);
        } catch (error) {
            console.error('Error marking messages as read:', error);
        }
    }

    setupPeriodicSync() {
        // Sync conversations every 30 seconds
        setInterval(() => {
            if (this.conversations.length > 0) {
                this.loadConversations(true).catch(console.error);
            }
        }, 30000);
    }

    // Cleanup
    destroy() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }
        if (this.ws) {
            this.ws.close();
        }
        this.messageQueue.clear();
        this.inFlightSends.clear();
        this.userCache.clear();
        this.courseCache.clear();
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChatEngine;
} else if (typeof window !== 'undefined') {
    window.ChatEngine = ChatEngine;
}