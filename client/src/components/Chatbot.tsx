import { useState, useRef, useEffect } from "react";
import { trpc } from "../utils/trpc.js";

export default function Chatbot({ searchId, onAction }: { searchId: number, onAction?: (action: any) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    { role: "user" | "model"; text: string }[]
  >([{ role: "model", text: "Hi! Ask me anything about these products. 🛍️" }]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const chatMutation = trpc.chat.sendMessage.useMutation();

  // Reset chat if the search context changes
  useEffect(() => {
    setMessages([{ role: "model", text: "Hi! Ask me anything about these products. 🛍️" }]);
  }, [searchId]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen]);

  const handleSend = async () => {
    if (!input.trim() || chatMutation.isPending) return;

    const userMsg = input.trim();
    setInput("");
    
    // Add user message to UI immediately
    const updatedMessages = [...messages, { role: "user" as const, text: userMsg }];
    setMessages(updatedMessages);

    try {
      const result = await chatMutation.mutateAsync({
        searchId,
        message: userMsg,
        history: messages.slice(1), // Exclude the initial greeting from Gemini API history
      });

      setMessages((prev) => [
        ...prev,
        { role: "model", text: result.text },
      ]);

      if (result.actions && result.actions.length > 0 && onAction) {
        result.actions.forEach((a: any) => onAction(a));
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "model", text: `Sorry, I hit an error: ${err.message}` },
      ]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSend();
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {/* Chat Window */}
      {isOpen && (
        <div className="absolute bottom-16 right-0 w-80 sm:w-96 rounded-2xl shadow-2xl glass-card overflow-hidden flex flex-col border border-phoenix-500/30 animate-scale-in" style={{ height: "450px" }}>
          {/* Header */}
          <div className="bg-gradient-to-r from-phoenix-600 to-phoenix-800 px-4 py-3 flex justify-between items-center shrink-0">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <span className="text-xl">🤖</span> Shopping Agent
            </h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/70 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex flex-col ${
                  msg.role === "user" ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2 shadow-sm text-sm ${
                    msg.role === "user"
                      ? "bg-phoenix-500 text-white rounded-br-none"
                      : "bg-surface-800 border border-white/5 text-gray-200 rounded-bl-none"
                  }`}
                >
                  {msg.text}
                </div>
                <span className="text-[10px] text-gray-500 mt-1 mx-1">
                  {msg.role === "user" ? "You" : "Gemini"}
                </span>
              </div>
            ))}
            {chatMutation.isPending && (
              <div className="flex items-start">
                <div className="max-w-[85%] rounded-2xl px-4 py-2 border border-white/5 bg-surface-800 rounded-bl-none">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-phoenix-400 border-t-transparent" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <div className="p-3 bg-surface-900 border-t border-white/5 flex gap-2 shrink-0">
            <input
              type="text"
              className="input-glass flex-1 rounded-full text-sm py-2 px-4 shadow-inner"
              placeholder="Ask about these products..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={chatMutation.isPending}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || chatMutation.isPending}
              className="h-10 w-10 shrink-0 rounded-full bg-phoenix-500 hover:bg-phoenix-400 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white shadow-lg transition-colors"
            >
              <svg className="w-4 h-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Toggle Button */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className={`h-14 w-14 rounded-full shadow-2xl flex items-center justify-center text-2xl transition-all duration-300 hover:scale-105 ${
          isOpen
            ? "bg-surface-800 border border-phoenix-500/50 text-phoenix-400"
            : "bg-phoenix-500 text-white hover:bg-phoenix-400"
        }`}
      >
        {isOpen ? "×" : "💬"}
      </button>
    </div>
  );
}
