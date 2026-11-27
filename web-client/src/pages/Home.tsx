import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { emailAPI, encodeFile, type Attachment } from '../services/api';
import { Paperclip, Download } from 'lucide-react';
import { Send, ArrowLeft, Plus, Settings, LogOut, Check, CheckCheck, MessageCircle, Maximize2, Minimize2, Menu, Sparkles, X, User, Trash2, Search, HelpCircle, Info, Forward, Edit2, Copy } from 'lucide-react';

interface Email {
  id: string;
  sender_email: string;
  sender_name?: string;
  delivery?: 'sending' | 'failed';
  attachments?: Attachment[];
  outgoing?: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };
  subject: string;
  body: string;
  is_read: boolean;
  created_at: string;
  recipients?: { recipient_email: string; recipient_type?: string; is_read?: boolean }[];
  cc?: { recipient_email: string }[];
  bcc?: { recipient_email: string }[];
}

interface Thread {
  contactEmail: string;
  contactName: string;
  messages: Email[];
  lastMessageAt: string;
  unreadCount: number;
}

interface Draft {
  body?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  files?: File[];
  error?: string;
  retryId?: string;
  forwardedId?: string;
}

function AttachmentLink({ emailId, file }: { emailId: string; file: Attachment }) {
  const [error, setError] = useState(false);
  async function download() {
    setError(false);
    try {
      const { data } = await emailAPI.downloadFile(emailId, file.id);
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setError(true); }
  }
  return <div>
    <button type="button" className="message-file" disabled={!file.available}
      aria-label={`Download ${file.filename}`} onClick={e => { e.stopPropagation(); void download(); }}>
      <Download size={16} /><span>{file.filename}</span>
      <small>{file.available ? `${Math.ceil(file.size_bytes / 1024)} KB` : 'Unavailable'}</small>
    </button>
    {error && <small role="alert">Download failed. Try again.</small>}
  </div>;
}

const QUICK_REPLIES = [
  "Sounds good!",
  "I'll get back to you.",
  "Thanks!",
  "Can we call?"
];

function newMessageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

const Home: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const cacheKey = `numo_threads_${user?.id}`;
  const namesKey = `numo_names_${user?.id}`;
  const [threads, setThreads] = useState<Thread[]>(() => {
    try {
      const saved = localStorage.getItem(cacheKey);
      const cached: Thread[] = saved ? JSON.parse(saved) : [];
      return cached.map(thread => ({ ...thread, messages: thread.messages.map(message =>
        message.delivery === 'sending' ? { ...message, delivery: 'failed' as const } : message
      ) }));
    } catch (e) {
      return [];
    }
  });
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const activeThread = threads.find(thread => thread.contactEmail === selectedAddress);
  const searchInput = useRef<HTMLInputElement>(null);
  const refreshNumber = useRef(0);
  const inFlight = useRef(new Set<string>());
  useEffect(() => { localStorage.setItem(cacheKey, JSON.stringify(threads)); }, [cacheKey, threads]);
  
  const [customNames, setCustomNames] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(namesKey);
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });

  const saveCustomName = (email: string, name: string) => {
    const updated = { ...customNames, [email]: name };
    setCustomNames(updated);
    localStorage.setItem(namesKey, JSON.stringify(updated));
    setThreads(prev => prev.map(t => t.contactEmail === email ? { ...t, contactName: name } : t));

  };

  const [isThreadSelectMode, setIsThreadSelectMode] = useState(false);
  const [selectedThreads, setSelectedThreads] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const sendingFiles = useRef(new Set<string>());
  const [uploading, setUploading] = useState<string[]>([]);
  const draft = drafts[selectedAddress || ''] || {};
  const { body: newMessageText = '', cc: composeCc = '', bcc: composeBcc = '', subject: composeSubject = '' } = draft;
  const updateDraft = (field: 'body' | 'cc' | 'bcc' | 'subject', value: string) => {
    if (selectedAddress && !sendingFiles.current.has(selectedAddress)) setDrafts(previous => ({
      ...previous, [selectedAddress]: { ...previous[selectedAddress], [field]: value, retryId: undefined, error: undefined } }));
  };

  
  // Sidebar State
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Expanded Compose State
  const [isExpandedCompose, setIsExpandedCompose] = useState(false);

  // New chat modal
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatInput, setNewChatInput] = useState('');
  const [newChatError, setNewChatError] = useState('');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Modals state
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  // Message selection state
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [forwardMessageData, setForwardMessageData] = useState<Email | null>(null);
  const picked = draft.files || [];
  const forwardedFiles = forwardMessageData?.attachments?.filter(file => file.available) || [];
  const isUploading = uploading.includes(selectedAddress || '');
  const attachButton = <button type="button" className="icon-btn" title="Attach files" aria-label="Attach files"
    disabled={isUploading} onClick={() => fileInput.current?.click()}><Paperclip size={20} /></button>;
  const canSend = !isUploading && Boolean(newMessageText.trim() || picked.length || forwardMessageData);
  const changeFiles = (files: File[]) => {
    if (!selectedAddress || isUploading) return;
    const total = files.reduce((n, f) => n + f.size, 0) + forwardedFiles.reduce((n, f) => n + f.size_bytes, 0);
    const error = files.length + forwardedFiles.length > 5 || total > 3 * 1024 * 1024
      ? 'Choose up to 5 files totaling 3 MiB or less.' : undefined;
    setDrafts(prev => ({ ...prev, [selectedAddress]: { ...prev[selectedAddress], error,
      ...(error ? {} : { files, retryId: undefined }) } }));
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchEmails();
    const intervalId = setInterval(fetchEmails, 3000);
    window.addEventListener('focus', fetchEmails);
    return () => {
      refreshNumber.current++;
      clearInterval(intervalId);
      window.removeEventListener('focus', fetchEmails);
    };
  }, [user?.id, customNames]);

  useEffect(() => {
    if (activeThread && !isExpandedCompose) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedAddress, activeThread?.messages.length, isExpandedCompose]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showAboutModal) {
        setShowAboutModal(false);
      } else if (showHelpModal) {
        setShowHelpModal(false);
      } else if (isSelectMode) {
        setIsSelectMode(false);
        setSelectedMessages(new Set());
      } else if (isThreadSelectMode) {
        setIsThreadSelectMode(false);
        setSelectedThreads(new Set());
      } else if (showNewChat) {
        setShowNewChat(false);
      } else if (isMenuOpen) {
        setIsMenuOpen(false);
      } else if (isExpandedCompose) {
        setIsExpandedCompose(false);
      } else if (activeThread) {
        setSelectedAddress(null);
      } else if (forwardMessageData) {
        setForwardMessageData(null);

      }
    };
    
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [showAboutModal, showHelpModal, isSelectMode, isThreadSelectMode, showNewChat, isMenuOpen, isExpandedCompose, activeThread, forwardMessageData]);

  const fetchEmails = async () => {
    const request = ++refreshNumber.current;
    try {
      const [inboxRes, sentRes] = await Promise.all([
        emailAPI.getEmails('inbox', 'all', 1),
        emailAPI.getEmails('sent', 'all', 1)
      ]);
      
      const allMails = [...(inboxRes.data.emails || []), ...(sentRes.data.emails || [])]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      if (request !== refreshNumber.current) return;
      const threadsMap = new Map<string, Thread>();

      allMails.forEach(email => {
        const isSentByMe = email.sender_email === user?.email;
        let counterpartEmail = '';
        let counterpartName = '';

        if (isSentByMe) {
          counterpartEmail = (email.recipients?.find((r: { recipient_type?: string }) => r.recipient_type === 'to') || email.recipients?.[0])?.recipient_email || 'Unknown';
          counterpartName = customNames[counterpartEmail] || counterpartEmail;
        } else {
          counterpartEmail = email.sender_email;
          counterpartName = customNames[counterpartEmail] || email.sender_name || email.sender_email;
        }

        if (!threadsMap.has(counterpartEmail)) {
          threadsMap.set(counterpartEmail, {
            contactEmail: counterpartEmail,
            contactName: counterpartName,
            messages: [],
            lastMessageAt: email.created_at,
            unreadCount: 0
          });
        }

        const thread = threadsMap.get(counterpartEmail)!;
        
        if (!thread.messages.some(m => m.id === email.id)) {
          thread.messages.push(email);
        }
        
        thread.lastMessageAt = email.created_at;
        
        if (!isSentByMe && !email.is_read) {
          thread.unreadCount += 1;
        }
      });

      setThreads(previous => {
        const merged = new Map([...threadsMap].map(([address, thread]) => [address, { ...thread, messages: [...thread.messages] }]));
        for (const local of previous) {
          const remote = merged.get(local.contactEmail);
          const pending = local.messages.filter(message => message.outgoing &&
            (!remote?.messages.some(saved => saved.id === message.id) || inFlight.current.has(message.id)));
          if (pending.length) {
            const ids = new Set(pending.map(m => m.id));
            const messages = [...(remote?.messages || []).filter(m => !ids.has(m.id)), ...pending]
              .sort((a, b) => a.created_at.localeCompare(b.created_at));
            merged.set(local.contactEmail, { ...(remote || local), messages, lastMessageAt: messages[messages.length - 1].created_at });
          } else if (!remote && !local.messages.length) {
            merged.set(local.contactEmail, local);
          }
        }
        return [...merged.values()].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      });
    } catch (error) {
      console.error('Failed to fetch emails', error);
    }
  };

  const deliver = async (address: string, message: Email) => {
    if (!message.outgoing || inFlight.current.has(message.id)) return;
    inFlight.current.add(message.id);
    const update = (changes: Partial<Email>) => setThreads(current => current.map(thread =>
      thread.contactEmail === address ? { ...thread, messages: thread.messages.map(m =>
        m.id === message.id ? { ...m, ...changes } : m) } : thread));
    update({ delivery: 'sending' });
    try {
      await emailAPI.sendEmail({ ...message.outgoing, clientMessageId: message.id });
      update({ delivery: undefined });
    } catch {
      update({ delivery: 'failed' });
    } finally {
      inFlight.current.delete(message.id);
      void fetchEmails();
    }
  };

  const handleSendMessage = async () => {
    let messageText = newMessageText.trim();
    if (forwardMessageData) {
      const fwText = `\n\n---------- Forwarded message ---------\nFrom: ${forwardMessageData.sender_name || forwardMessageData.sender_email}\nDate: ${new Date(forwardMessageData.created_at).toLocaleString()}\nSubject: ${forwardMessageData.subject || 'No Subject'}\n\n${forwardMessageData.body}`;
      messageText = messageText ? `${messageText}${fwText}` : fwText.trim();
    }

    if (!canSend || !activeThread || sendingFiles.current.has(activeThread.contactEmail)) return;
    
    const toList = [activeThread.contactEmail];
    const ccList = composeCc ? composeCc.split(',').map((e) => e.trim()).filter(Boolean) : [];
    const bccList = composeBcc ? composeBcc.split(',').map((e) => e.trim()).filter(Boolean) : [];
    const subject = composeSubject || 'Numo Message';
    
    const address = activeThread.contactEmail;
    const id = draft.retryId && draft.forwardedId === forwardMessageData?.id ? draft.retryId : newMessageId();
    const message: Email = {
      id, sender_email: user!.email, subject, body: messageText,
      created_at: new Date().toISOString(), is_read: true, delivery: 'sending',
      recipients: [{ recipient_email: address }],
      outgoing: { to: toList, cc: ccList, bcc: bccList, subject, body: messageText }
    };
    const hasFiles = picked.length > 0 || forwardedFiles.length > 0;
    if (hasFiles) {
      // Keep files in the composer until acknowledgement, including when a retry is needed.
      sendingFiles.current.add(address);
      setUploading(prev => [...prev, address]);
      setDrafts(prev => ({ ...prev, [address]: { ...prev[address], error: undefined, retryId: id, forwardedId: forwardMessageData?.id } }));
      try {
        const files = await Promise.all(picked.map(encodeFile));
        const response = await emailAPI.sendEmail({ ...message.outgoing!, clientMessageId: id,
          attachments: [...forwardedFiles.map(file => ({ id: file.id })), ...files] });
        message.attachments = response.data.email.attachments;
        delete message.outgoing;
        delete message.delivery;
      } catch (error: any) {
        setDrafts(prev => ({ ...prev, [address]: { ...prev[address],
          error: error.response?.data?.error || 'Could not send the files. Your selection is ready to retry.' } }));
        return;
      } finally {
        sendingFiles.current.delete(address);
        setUploading(prev => prev.filter(item => item !== address));
      }
    }
    setThreads(current => current.map(thread => thread.contactEmail === address && !thread.messages.some(m => m.id === id)
      ? { ...thread, messages: [...thread.messages, message], lastMessageAt: message.created_at } : thread));
    setDrafts(previous => ({ ...previous, [address]: {} }));
    setForwardMessageData(current => current === forwardMessageData ? null : current);
    if (!hasFiles) { setIsExpandedCompose(false); await deliver(address, message); }
    else void fetchEmails();
  };

  const handleStartNewChat = async () => {
    if (!newChatInput.trim()) {
      setNewChatError('Enter a phone number or email ID');
      return;
    }
    
    let targetEmail = newChatInput.trim();
    if (!targetEmail.includes('@')) {
      const domain = user?.email.split('@')[1];
      const digits = targetEmail.replace(/\D/g, '').slice(-10);
      if (!domain || digits.length !== 10) {
        setNewChatError('Enter a ten-digit phone number or an email address.');
        return;
      }
      targetEmail = `${digits}@${domain}`;
    }

    let existingThread = threads.find(t => t.contactEmail === targetEmail);
    if (!existingThread) {
      existingThread = {
        contactEmail: targetEmail,
        contactName: targetEmail,
        messages: [],
        lastMessageAt: new Date().toISOString(),
        unreadCount: 0
      };
      const created = existingThread;
      setThreads(previous => [created, ...previous]);
    }
    
    setSelectedAddress(existingThread.contactEmail);
    setShowNewChat(false);
    setNewChatInput('');
    setNewChatError('');
  };

  const markThreadAsRead = async (thread: Thread) => {
    const unreadMessages = thread.messages.filter(m => !m.is_read && m.sender_email !== user?.email);
    if (unreadMessages.length > 0) {
      for (const msg of unreadMessages) {
        try {
          await emailAPI.markAsRead(msg.id);
        } catch (e) {
          console.error(e);
        }
      }
      fetchEmails();
    }
  };

  const unreadIds = activeThread?.messages.filter(m => !m.is_read && m.sender_email !== user?.email).map(m => m.id).join(',');
  useEffect(() => {
    if (activeThread && unreadIds) void markThreadAsRead(activeThread);
  }, [selectedAddress, unreadIds]);

  const getInitials = (name: string) => {
    let cleanName = name.split('@')[0];
    cleanName = cleanName.replace(/[^a-zA-Z]/g, '');
    if (!cleanName) return <User size={20} />;
    return cleanName.slice(0, 2).toUpperCase();
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const toggleSelectMessage = (msgId: string) => {
    setSelectedMessages(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      if (next.size === 0) setIsSelectMode(false);
      return next;
    });
  };

  const handleDeleteSelected = async () => {
    const count = selectedMessages.size;
    if (count === 0) return;
    const confirmed = confirm(`Delete ${count} message${count > 1 ? 's' : ''}?`);
    if (!confirmed) return;
    
    // Optimistic UI Update
    const messagesToDelete = new Set(selectedMessages);
    setSelectedMessages(new Set());
    setIsSelectMode(false);

    if (activeThread) {
      const updatedMessages = activeThread.messages.filter(m => !messagesToDelete.has(m.id));
      const updatedThread = { ...activeThread, messages: updatedMessages };

      setThreads(prev => {
        const next = prev.map(t => t.contactEmail === updatedThread.contactEmail ? updatedThread : t);
        return next;
      });
    }

    for (const msgId of messagesToDelete) {
      try {
        await emailAPI.deleteEmail(msgId);
      } catch (e) {
        console.error('Delete failed for', msgId, e);
      }
    }
    fetchEmails();
  };

  const handlePickContact = async () => {
    try {
      if ('contacts' in navigator) {
        const contacts = await (navigator as any).contacts.select(['name', 'tel'], { multiple: false });
        if (contacts.length > 0 && contacts[0].tel.length > 0) {
          setNewChatInput(contacts[0].tel[0].replace(/[^0-9+]/g, ''));
        }
      } else {
        alert('Enter a phone number or email address.');
      }
    } catch (ex: any) {
      alert('Error picking contact: ' + (ex.message || JSON.stringify(ex)));
    }
  };

  const toggleSelectThread = (email: string) => {
    setSelectedThreads(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      if (next.size === 0) setIsThreadSelectMode(false);
      return next;
    });
  };

  const handleDeleteSelectedThreads = async () => {
    const count = selectedThreads.size;
    if (count === 0) return;
    if (!confirm(`Delete ${count} selected chats?`)) return;
    
    setThreads(prev => {
      const remaining = prev.filter(t => !selectedThreads.has(t.contactEmail));
      return remaining;
    });
    if (activeThread && selectedThreads.has(activeThread.contactEmail)) setSelectedAddress(null);
    setIsThreadSelectMode(false);
    
    for (const email of selectedThreads) {
       const thread = threads.find(t => t.contactEmail === email);
       if (thread) {
         try {
           await Promise.all(thread.messages.map(m => emailAPI.deleteEmail(m.id)));
         } catch(e) {}
       }
    }
    setSelectedThreads(new Set());
    fetchEmails();
  };

  const filteredThreads = threads.filter(t => 
    t.contactName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.contactEmail.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className={`hybrid-layout ${activeThread ? 'chat-active' : ''}`}>
      
      {/* SIDEBAR OVERLAY */}
      {isMenuOpen && (
        <div className="hb-overlay" onClick={() => setIsMenuOpen(false)}>
          <div className="hb-menu" onClick={e => e.stopPropagation()}>
            <div className="hb-header">
              <div className="hb-avatar">{getInitials(user?.email || '')}</div>
              <div className="hb-user-info">
                <h3>{(user?.email || '').split('@')[0]}</h3>
                <p>{user?.email}</p>
              </div>
              <button className="icon-btn" onClick={() => setIsMenuOpen(false)} style={{ background: 'transparent', border: 'none' }}>
                <X size={24} color="var(--text-primary)" />
              </button>
            </div>
            
            <div className="hb-content">
              {/* Profile Section */}
              <div className="hb-section">
                <button className="hb-btn" onClick={() => { setIsMenuOpen(false); navigate('/settings'); }}>
                  <User size={20} color="var(--primary)" /> My Profile
                </button>
                <button className="hb-btn" onClick={() => { setIsMenuOpen(false); setSearchQuery(''); requestAnimationFrame(() => searchInput.current?.focus()); }}>
                  <Search size={20} color="var(--primary)" /> Search conversations
                </button>
              </div>

              {/* Menu Options */}
              <div className="hb-section">
                <button className="hb-btn" onClick={() => { setIsMenuOpen(false); navigate('/settings'); }}>
                  <Settings size={20} color="var(--primary)" /> Settings
                </button>
                <button className="hb-btn" onClick={() => { setIsMenuOpen(false); setShowAboutModal(true); }}>
                  <Info size={20} color="var(--primary)" /> About Numo
                </button>
                <button className="hb-btn" onClick={() => { setIsMenuOpen(false); setShowHelpModal(true); }}>
                  <HelpCircle size={20} color="var(--primary)" /> Help & FAQ
                </button>
              </div>

              <div className="hb-actions">
                <button className="hb-btn hb-logout" onClick={() => { logout(); navigate('/login'); }}>
                  <LogOut size={20} /> Logout
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* LEFT PANE */}
      <div className="thread-list-pane">
        <div className="hybrid-header">
          {isThreadSelectMode ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button className="icon-btn" onClick={() => { setIsThreadSelectMode(false); setSelectedThreads(new Set()); }} style={{ border: 'none', background: 'transparent' }}>
                  <X size={24} color="var(--primary)" />
                </button>
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{selectedThreads.size} selected</h2>
              </div>
              <div className="header-actions">
                <button className="icon-btn" onClick={handleDeleteSelectedThreads} style={{ border: 'none', background: 'transparent' }} title="Delete Selected">
                  <Trash2 size={24} color="var(--danger)" />
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button className="icon-btn" onClick={() => setIsMenuOpen(true)} style={{ border: 'none', background: 'transparent' }} title="Menu">
                  <Menu size={24} color="var(--primary)" />
                </button>
                <div className="wordmark inbox-brand"><img src="/favicon.svg" alt="" width="29" height="29" />Numo</div>
              </div>
              <div className="header-actions">
                <button className="icon-btn" onClick={() => setIsThreadSelectMode(true)} title="Select Chats" style={{ border: 'none', background: 'transparent', marginRight: '8px' }}>
                   <CheckCheck size={20} color="var(--primary)" />
                </button>
                <button className="icon-btn" onClick={() => setIsMenuOpen(true)} title="Profile">
                  <div className="hb-avatar-small">{getInitials(user?.email || '')}</div>
                </button>
              </div>
            </>
          )}
        </div>

        <div className="inbox-heading">
          <h1>Inbox</h1>
          <button className="compose-button" onClick={() => setShowNewChat(true)}><Plus size={17} />Compose</button>
        </div>

        {/* Forward Banner */}
        {forwardMessageData && !isThreadSelectMode && (
          <div style={{ padding: '8px 12px', background: 'var(--primary-light)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.9rem' }}>
            <span style={{ fontWeight: 500 }}>Select chat to forward to</span>
            <button className="icon-btn" onClick={() => setForwardMessageData(null)} style={{ border: 'none', background: 'transparent' }} title="Cancel Forward">
              <X size={18} color="var(--text-primary)" />
            </button>
          </div>
        )}

        {/* Search Bar */}
        <div className="inbox-search">
          <div>
            <Search size={16} color="var(--text-tertiary)" />
            <input 
              type="text" 
              ref={searchInput} placeholder="Search conversations" aria-label="Search conversations"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none', fontSize: '0.9rem' }}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
                <X size={14} color="var(--text-tertiary)" />
              </button>
            )}
          </div>
        </div>
        
        <div className="thread-list-scroll">
          {filteredThreads.length === 0 ? (
            <div className="empty-room" style={{ height: '100%', padding: '20px', textAlign: 'center' }}>
              <p>{searchQuery ? 'No chats found.' : 'No conversations yet. Choose Compose to write your first email.'}</p>
            </div>
          ) : (
            filteredThreads.map((thread) => (
              <div 
                key={thread.contactEmail} 
                tabIndex={0} role="button" aria-label={`Open conversation with ${thread.contactName}`}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                className={`thread-item ${activeThread?.contactEmail === thread.contactEmail ? 'active' : ''} ${selectedThreads.has(thread.contactEmail) ? 'msg-selected' : ''}`}
                onClick={(e) => {
                  if ((window as any).__ignoreNextClick) {
                    (window as any).__ignoreNextClick = false;
                    return;
                  }
                  if (isThreadSelectMode) {
                    toggleSelectThread(thread.contactEmail);
                  } else {
                    setSelectedAddress(thread.contactEmail);
                    setIsSelectMode(false);
                    setSelectedMessages(new Set());
                    setIsExpandedCompose(false);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setIsThreadSelectMode(true);
                  toggleSelectThread(thread.contactEmail);
                }}
                onTouchStart={() => {
                  if (!isThreadSelectMode) {
                    const timer = setTimeout(() => {
                      (window as any).__ignoreNextClick = true;
                      setIsThreadSelectMode(true);
                      toggleSelectThread(thread.contactEmail);
                      if (navigator.vibrate) navigator.vibrate(50);
                    }, 500);
                    (window as any).__longPressThreadTimer = timer;
                  }
                }}
                onTouchEnd={() => clearTimeout((window as any).__longPressThreadTimer)}
                onTouchMove={() => clearTimeout((window as any).__longPressThreadTimer)}
                style={{ position: 'relative' }}
              >
                {isThreadSelectMode && (
                   <div style={{ position: 'absolute', bottom: '12px', left: '44px', zIndex: 5, width: '20px', height: '20px', borderRadius: '50%', background: selectedThreads.has(thread.contactEmail) ? 'var(--primary)' : 'var(--bg-elevated)', border: selectedThreads.has(thread.contactEmail) ? 'none' : '2px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                     {selectedThreads.has(thread.contactEmail) && <Check size={14} color="var(--text-inverse)" />}
                   </div>
                )}
                <div className="thread-avatar">
                  {getInitials(thread.contactName)}
                </div>
                <div className="thread-info">
                  <div className="thread-top">
                    <span className="thread-name">{thread.contactName.split('@')[0]}</span>
                    <span className="thread-time">{formatTime(thread.lastMessageAt)}</span>
                  </div>
                  <div className="thread-preview" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>
                      {thread.messages.length > 0 
                        ? (thread.messages[thread.messages.length - 1].sender_email === user?.email ? 'You: ' : '') +
                          (thread.messages[thread.messages.length - 1].body || thread.messages[thread.messages.length - 1].attachments?.[0]?.filename || '')
                        : 'New Chat'}
                    </span>
                    {thread.unreadCount > 0 && (
                      <span className="unread-badge">{thread.unreadCount}</span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>


      </div>

      {/* RIGHT PANE */}
      <div className="thread-room-pane">
        {activeThread ? (
          <>
            <div className="room-header">
              {isSelectMode ? (
                <>
                  <button className="back-btn" onClick={() => { setIsSelectMode(false); setSelectedMessages(new Set()); }}>
                    <X size={24} />
                  </button>
                  <div style={{ flex: 1, fontWeight: '600', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
                    {selectedMessages.size} selected
                  </div>
                  {selectedMessages.size === 1 && (
                    <button 
                      className="icon-btn" 
                      onClick={() => {
                        const msgId = Array.from(selectedMessages)[0];
                        const msg = activeThread.messages.find(m => m.id === msgId);
                        if (msg) {
                          setForwardMessageData(msg);
                          setSelectedAddress(null);
                          setIsSelectMode(false);
                          setSelectedMessages(new Set());
                        }
                      }}
                      style={{ background: 'transparent', border: 'none', marginRight: '8px' }}
                      title="Forward"
                    >
                      <Forward size={22} color="var(--text-primary)" />
                    </button>
                  )}
                  {selectedMessages.size > 0 && (
                    <button 
                      className="icon-btn" 
                      onClick={() => {
                        const textsToCopy = Array.from(selectedMessages).map(msgId => {
                          const msg = activeThread.messages.find(m => m.id === msgId);
                          return msg ? msg.body : '';
                        }).filter(Boolean).join('\n\n');
                        navigator.clipboard.writeText(textsToCopy).then(() => {
                          setIsSelectMode(false);
                          setSelectedMessages(new Set());
                        });
                      }}
                      style={{ background: 'transparent', border: 'none', marginRight: '8px' }}
                      title="Copy"
                    >
                      <Copy size={20} color="var(--text-primary)" />
                    </button>
                  )}
                  <button 
                    className="icon-btn" 
                    title="Delete Selected" 
                    onClick={handleDeleteSelected}
                    style={{ background: 'transparent', border: 'none' }}
                  >
                    <Trash2 size={22} color="var(--danger)" />
                  </button>
                </>
              ) : (
                <>
                  <button className="back-btn" onClick={() => { setSelectedAddress(null); setIsExpandedCompose(false); }}>
                    <ArrowLeft size={24} />
                  </button>
                  <div className="thread-avatar" style={{ width: '40px', height: '40px', fontSize: '1rem' }}>
                    {getInitials(activeThread.contactName)}
                  </div>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div>
                      <div style={{ fontWeight: '600', color: 'var(--text-primary)' }}>{activeThread.contactName}</div>
                      {activeThread.contactName !== activeThread.contactEmail && (
                         <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{activeThread.contactEmail}</div>
                      )}
                    </div>
                    <button className="icon-btn" onClick={() => {
                      const newName = window.prompt("Enter name for " + activeThread.contactEmail, activeThread.contactName !== activeThread.contactEmail ? activeThread.contactName : '');
                      if (newName !== null) saveCustomName(activeThread.contactEmail, newName);
                    }} style={{ background: 'transparent', border: 'none', padding: '4px' }} title="Edit Name">
                      <Edit2 size={16} color="var(--primary)" />
                    </button>
                  </div>
                  <button 
                    className="icon-btn" 
                    title="Clear Chat" 
                    onClick={async () => {
                      if (!window.confirm("Are you sure you want to clear this chat?")) return;
                      const threadToDelete = activeThread;
                      setThreads(prev => prev.filter(t => t.contactEmail !== threadToDelete.contactEmail));
                      setSelectedAddress(null);
                      try {
                        const promises = threadToDelete.messages.map(msg => emailAPI.deleteEmail(msg.id));
                        await Promise.all(promises);
                      } catch (err) {
                        console.error("Failed to delete all messages", err);
                      }
                    }}
                    style={{ background: 'transparent', border: 'none' }}
                  >
                    <Trash2 size={20} color="var(--danger)" />
                  </button>
                </>
              )}
            </div>

            <div className="room-messages">
              {activeThread.messages.length === 0 ? (
                <div className="empty-room">
                  <MessageCircle size={48} />
                  <p>Send a message to start the conversation.</p>
                </div>
              ) : (
                activeThread.messages.map((msg, idx) => {
                  const isMine = msg.sender_email === user?.email;
                  const isReadByRecipient = msg.recipients?.some(r => r.is_read);
                  const isSelected = selectedMessages.has(msg.id);
                  return (
                    <div 
                      key={msg.id || idx} 
                      className={`message-card ${isMine ? 'msg-sent' : 'msg-received'} ${isSelected ? 'msg-selected' : ''}`}
                      onClick={(e) => {
                        if ((window as any).__ignoreNextClickMsg) {
                          (window as any).__ignoreNextClickMsg = false;
                          return;
                        }
                        if (isSelectMode && msg.id) toggleSelectMessage(msg.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setIsSelectMode(true);
                        toggleSelectMessage(msg.id);
                      }}
                      onTouchStart={() => {
                        if (!isSelectMode && msg.id) {
                          const timer = setTimeout(() => {
                            (window as any).__ignoreNextClickMsg = true;
                            setIsSelectMode(true);
                            toggleSelectMessage(msg.id!);
                            if (navigator.vibrate) navigator.vibrate(50);
                          }, 500);
                          (window as any).__longPressTimer = timer;
                        }
                      }}
                      onTouchEnd={() => {
                        clearTimeout((window as any).__longPressTimer);
                      }}
                      onTouchMove={() => {
                        clearTimeout((window as any).__longPressTimer);
                      }}
                      style={{ position: 'relative', cursor: isSelectMode ? 'pointer' : 'default' }}
                    >
                      {isSelectMode && (
                        <div style={{
                          position: 'absolute',
                          top: '8px',
                          left: isMine ? 'auto' : '8px',
                          right: isMine ? '8px' : 'auto',
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          border: isSelected ? 'none' : '2px solid var(--text-tertiary)',
                          background: isSelected ? 'var(--primary)' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          zIndex: 2
                        }}>
                          {isSelected && <Check size={14} color="var(--text-inverse)" />}
                        </div>
                      )}
                      {msg.subject && msg.subject !== 'Numo Message' && msg.subject !== '(No Subject)' && (
                        <span className="msg-subject">{msg.subject}</span>
                      )}
                      <div style={{ whiteSpace: 'pre-wrap' }}>{msg.body}</div>
                      {msg.attachments?.map(file => <AttachmentLink key={file.id} emailId={msg.id} file={file} />)}
                      <div className={`msg-time ${isMine ? 'sent-time' : ''}`}>
                        {formatTime(msg.created_at)}
                        {isMine && (
                          msg.delivery === 'failed' ? (
                            <button className="retry-message" onClick={e => { e.stopPropagation(); void deliver(activeThread.contactEmail, msg); }}>Failed · Retry</button>
                          ) : msg.delivery === 'sending' ? <span>Sending…</span> : (
                            <span className="receipt" title={isReadByRecipient ? 'Read' : 'Sent'}>
                              {isReadByRecipient ? <CheckCheck size={16} /> : <Check size={16} />}
                              {isReadByRecipient ? 'Read' : 'Sent'}
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick Replies - Smart Feature */}
            {!isExpandedCompose && (
              <div className="quick-replies-wrapper">
                <Sparkles size={14} color="var(--primary)" style={{ marginLeft: '12px' }} />
                <div className="quick-replies-scroll">
                  {QUICK_REPLIES.map(reply => (
                    <button 
                      key={reply} 
                      className="quick-reply-chip"
                      onClick={() => updateDraft('body', reply)}
                    >
                      {reply}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {forwardMessageData && (
              <div style={{
                backgroundColor: 'var(--bg-elevated)',
                padding: '8px 12px',
                margin: '0 12px 8px 12px',
                borderRadius: '8px',
                borderLeft: '4px solid var(--primary)',
                display: 'flex',
                flexDirection: 'column',
                position: 'relative'
              }}>
                <button 
                  onClick={() => setForwardMessageData(null)}
                  style={{ position: 'absolute', top: '4px', right: '4px', background: 'transparent', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}>
                  <X size={16} />
                </button>
                <span style={{ fontSize: '0.8rem', color: 'var(--primary)', marginBottom: '4px', fontWeight: 600 }}>
                  Forwarded message
                </span>
                <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', paddingRight: '20px' }}>
                  {forwardMessageData.body.length > 80 ? forwardMessageData.body.substring(0, 80) + '...' : forwardMessageData.body}
                </span>
              </div>
            )}

            <input type="file" multiple hidden ref={fileInput} aria-label="Choose attachments"
              onChange={event => {
                const added = Array.from(event.currentTarget.files || []);
                if (added.length) changeFiles([...picked, ...added]);
                event.currentTarget.value = '';
              }} />
            {(picked.length > 0 || forwardedFiles.length > 0) && <div className="compose-files" aria-label="Selected attachments">
              {forwardedFiles.map(file => <span key={file.id}><Paperclip size={14} />{file.filename}</span>)}
              {picked.map((file, index) => <span key={index}><Paperclip size={14} />{file.name}
                <button type="button" aria-label={`Remove ${file.name}`} disabled={isUploading}
                  onClick={() => changeFiles(picked.filter((_, i) => i !== index))}><X size={14} /></button></span>)}
            </div>}
            {draft.error && <p className="file-status" role="alert">{draft.error}</p>}
            {isUploading && <p className="file-status" role="status">Sending attachments…</p>}
            {isExpandedCompose ? (
              <div className="expanded-compose">
                <div className="compose-field-row">
                  <label>To</label>
                  <input type="text" value={activeThread.contactEmail} disabled />
                </div>
                <div className="compose-field-row">
                  <label>Cc</label>
                  <input type="text" placeholder="Add Cc" value={composeCc} onChange={e => updateDraft('cc', e.target.value)} />
                </div>
                <div className="compose-field-row">
                  <label>Bcc</label>
                  <input type="text" placeholder="Add Bcc" value={composeBcc} onChange={e => updateDraft('bcc', e.target.value)} />
                </div>
                <div className="compose-field-row">
                  <label>Subject</label>
                  <input type="text" placeholder="Subject" value={composeSubject} onChange={e => updateDraft('subject', e.target.value)} />
                </div>
                <textarea 
                  placeholder="Write your email..." 
                  value={newMessageText} 
                  onChange={e => updateDraft('body', e.target.value)}
                  autoFocus
                />
                <div className="compose-actions">
                  {attachButton}
                  <button className="btn-collapse" onClick={() => setIsExpandedCompose(false)}>
                    <Minimize2 size={16} /> Chat Mode
                  </button>
                  <button 
                    className="send-btn" 
                    style={{ borderRadius: '8px', width: 'auto', padding: '0 24px' }}
                    onClick={handleSendMessage} 
                    disabled={!canSend}
                  >
                    <Send size={18} style={{ marginRight: '8px' }} /> Send Email
                  </button>
                </div>
              </div>
            ) : (
              <div className="room-input-area">
                {attachButton}
                <button 
                  className="icon-btn" 
                  title="Expand Compose" 
                  onClick={() => setIsExpandedCompose(true)}
                >
                  <Maximize2 size={20} color="var(--text-tertiary)" />
                </button>
                
                <input
                  type="text"
                  className="chat-input"
                  placeholder="Message"
                  value={newMessageText}
                  onChange={(e) => updateDraft('body', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSendMessage();
                  }}
                />
                <button 
                  className="send-btn" aria-label="Send message"
                  onClick={handleSendMessage} 
                  disabled={!canSend}
                >
                  <Send size={20} style={{ marginLeft: '-2px' }} />
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="empty-room inbox-idle">
            <img src="/favicon.svg" alt="" width="64" height="64" />
            <h2>Open a conversation</h2>
            <p>Choose a conversation from your inbox to read or reply.</p>
          </div>
        )}
      </div>

      {/* NEW CHAT MODAL */}
      {showNewChat && (
        <div className="new-chat-modal" onClick={(e) => { if(e.target === e.currentTarget) setShowNewChat(false); }}>
          <div className="new-chat-box">
            <h3>New message</h3>
            {'contacts' in navigator && <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <button className="btn-secondary" style={{ flex: 1, padding: '8px', borderRadius: '8px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }} onClick={handlePickContact}>
                <User size={16} color="var(--primary)" /> Pick from Contacts
              </button>
            </div>}
            <input 
              type="text"
              placeholder="Phone number or email address" aria-label="Recipient"
              value={newChatInput}
              onChange={(e) => setNewChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleStartNewChat(); }}
              autoFocus
            />
            {newChatError && <div style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '12px' }}>{newChatError}</div>}
            <div className="new-chat-actions">
              <button className="btn-cancel" onClick={() => setShowNewChat(false)}>Cancel</button>
              <button className="btn-start" onClick={handleStartNewChat}>Start conversation</button>
            </div>
          </div>
        </div>
      )}

      {/* ABOUT MODAL */}
      {showAboutModal && (
        <div className="modal-overlay" onClick={() => setShowAboutModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ padding: '24px', textAlign: 'center', background: 'var(--bg-secondary)', borderRadius: '16px', maxWidth: '340px', width: '90%' }}>
            <img src="/favicon.svg" width="48" height="48" alt="" />
            <h2>About Numo</h2>
            <p className="about-copy">Your phone number is your email address. Numo keeps the messages you send and receive together in one conversation.</p>
            <p className="about-address">{user?.email}</p>
            <button className="btn-primary" onClick={() => setShowAboutModal(false)} style={{ width: '100%' }}>Close</button>
          </div>
        </div>
      )}

      {/* HELP MODAL */}
      {showHelpModal && (
        <div className="modal-overlay" onClick={() => setShowHelpModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ padding: '24px', background: 'var(--bg-secondary)', borderRadius: '16px', maxWidth: '340px', width: '90%' }}>
            <h2 style={{ color: 'var(--text-primary)', marginBottom: '20px', fontSize: '1.4rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HelpCircle color="var(--primary)" /> Help & FAQ
            </h2>
            <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '16px', color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5' }}>
              <div>
                <b style={{ color: 'var(--text-primary)' }}>How do I send an email?</b>
                <div>Choose Compose, enter a phone number or email address, then write your message.</div>
              </div>
              <div>
                <b style={{ color: 'var(--text-primary)' }}>What is my email address?</b>
                <div>Your email address is {user?.email}.</div>
              </div>
              <div>
                <b style={{ color: 'var(--text-primary)' }}>How do I delete messages?</b>
                <div>Right-click a message, or touch and hold it, then choose the trash icon.</div>
              </div>
            </div>
            <button className="btn-primary" onClick={() => setShowHelpModal(false)} style={{ width: '100%', marginTop: '24px' }}>Close</button>
          </div>
        </div>
      )}

    </div>
  );
};

export default Home;
