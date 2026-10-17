import React, { useState, useRef, useEffect } from 'react';
import { PaperPlaneRight, Trash, Check, Copy, Info, Warning, Sparkle } from '@phosphor-icons/react';
import type { ChatbotState, ChatMessage } from '../chatbot/types';
import type { TimelineRow, TimelineInbound } from '../bridge/timeline';

interface ChatbotViewProps {
  state?: ChatbotState;
  rows: TimelineRow[];
  selectedCheckpointId?: string;
  renderedCheckpoints?: string[];
  send: (message: TimelineInbound) => void;
}

export const ChatbotView: React.FC<ChatbotViewProps> = ({
  state,
  rows,
  selectedCheckpointId,
  renderedCheckpoints = [],
  send
}) => {
  const [inputQuery, setInputQuery] = useState('');
  const [compareId, setCompareId] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeId = selectedCheckpointId ?? rows.at(-1)?.id;
  const hasScreenshot = activeId ? renderedCheckpoints.includes(activeId) : false;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state?.messages?.length, state?.busy]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputQuery.trim() || state?.busy) return;

    send({
      type: 'ask-chatbot',
      query: inputQuery.trim(),
      checkpointId: activeId,
      compareCheckpointId: compareId || undefined
    });

    setInputQuery('');
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const messages: ChatMessage[] = state?.messages ?? [];

  return (
    <div className="chatbot-container" aria-label="UI/UX Design Advisor Chatbot">
      <div className="chatbot-meta-bar">
        <span className="chatbot-meta-item">
          <strong>Checkpoint:</strong> {activeId ? activeId.slice(0, 7) : 'None'}
        </span>
        <span
          className={`chatbot-meta-evidence ${hasScreenshot ? 'verified' : 'unverified'}`}
          title={
            hasScreenshot
              ? 'Rendered screenshot and element regions are cached and available for inspection.'
              : 'No rendered screenshot cached. Recommendations are based on static CSS and HTML source code.'
          }
        >
          {hasScreenshot ? '📸 Screenshot evidence' : '📄 Source-code evidence only'}
        </span>
      </div>

      <div className="chatbot-compare-selector">
        <label htmlFor="chatbot-compare-select">Compare version:</label>
        <select
          id="chatbot-compare-select"
          value={compareId}
          onChange={(e) => setCompareId(e.target.value)}
        >
          <option value="">(None - inspect active checkpoint)</option>
          {rows
            .filter((r) => r.id !== activeId)
            .slice(-50)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 7)} {r.alternative ? `(${r.alternative})` : ''} -{' '}
                {new Date(r.createdAt).toLocaleTimeString()}
              </option>
            ))}
        </select>
      </div>

      <div className="chatbot-message-list" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chatbot-empty-state">
            <Sparkle size={32} aria-hidden="true" />
            <p>
              Ask any UI/UX question about your frontend layout, spacing, typography, navigation, or
              historical changes.
            </p>
            <p className="chatbot-hint">
              This advisor is strictly non-agentic: it will make specific recommendations and
              provide copyable snippets, but will never modify your files.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`chatbot-message ${msg.sender}`}>
              <div className="chatbot-message-header">
                <strong>{msg.sender === 'user' ? 'You' : 'Scrubline Design Advisor'}</strong>
                <span className="chatbot-timestamp">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>

              <div className="chatbot-message-body">
                <p className="chatbot-text">{msg.text}</p>

                {msg.advice && (
                  <div className="chatbot-advice-content">
                    <div className="chatbot-summary-box">
                      <p>
                        <strong>Summary:</strong> {msg.advice.summary}
                      </p>
                    </div>

                    {msg.advice.disclaimers.length > 0 && (
                      <div className="chatbot-disclaimers">
                        {msg.advice.disclaimers.map((d, i) => (
                          <div key={i} className="chatbot-disclaimer-item">
                            <Info size={14} aria-hidden="true" />
                            <span>{d}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {msg.advice.findings.length > 0 && (
                      <div className="chatbot-section">
                        <h4>Observations & Evidence</h4>
                        <ul className="chatbot-findings-list">
                          {msg.advice.findings.map((f, i) => (
                            <li key={i} className={`chatbot-finding-item ${f.type}`}>
                              <span className="chatbot-finding-title">
                                {f.type === 'issue' ? (
                                  <Warning size={14} aria-hidden="true" />
                                ) : (
                                  <Info size={14} aria-hidden="true" />
                                )}
                                <strong>{f.title}</strong>
                              </span>
                              <p>{f.details}</p>
                              {f.evidence.length > 0 && (
                                <div className="chatbot-evidence-tags">
                                  {f.evidence.map((ev, evIdx) => (
                                    <span key={evIdx} className="chatbot-evidence-tag">
                                      {ev.file ? `${ev.file}: ` : ''}
                                      {ev.description}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {msg.advice.recommendations.length > 0 && (
                      <div className="chatbot-section">
                        <h4>Concrete Recommendations</h4>
                        <div className="chatbot-recommendations-list">
                          {msg.advice.recommendations.map((rec) => (
                            <div key={rec.id} className="chatbot-rec-card">
                              <div className="chatbot-rec-header">
                                <span className={`chatbot-priority-badge ${rec.priority}`}>
                                  {rec.priority.toUpperCase()} PRIORITY
                                </span>
                                <strong>{rec.title}</strong>
                              </div>
                              <p className="chatbot-rec-desc">{rec.description}</p>
                              <div className="chatbot-rec-rationale">
                                <strong>Why this helps:</strong> {rec.rationale}
                              </div>
                              <div className="chatbot-rec-tradeoffs">
                                <strong>Trade-offs:</strong> {rec.tradeOffs}
                              </div>
                              {rec.suggestedCode && (
                                <div className="chatbot-code-block">
                                  <div className="chatbot-code-header">
                                    <span>Proposed CSS / Code</span>
                                    <button
                                      type="button"
                                      className="chatbot-copy-btn"
                                      onClick={() => handleCopy(rec.id, rec.suggestedCode!)}
                                      title="Copy snippet to clipboard"
                                    >
                                      {copiedId === rec.id ? (
                                        <>
                                          <Check size={12} aria-hidden="true" /> Copied
                                        </>
                                      ) : (
                                        <>
                                          <Copy size={12} aria-hidden="true" /> Copy
                                        </>
                                      )}
                                    </button>
                                  </div>
                                  <pre>
                                    <code>{rec.suggestedCode}</code>
                                  </pre>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {msg.advice.suggestedSnippets.length > 0 && (
                      <div className="chatbot-section">
                        <h4>Code Snippets for Manual Review</h4>
                        {msg.advice.suggestedSnippets.map((snip, sIdx) => (
                          <div key={sIdx} className="chatbot-code-block">
                            <div className="chatbot-code-header">
                              <span>
                                {snip.title} {snip.targetFile ? `(${snip.targetFile})` : ''}
                              </span>
                              <button
                                type="button"
                                className="chatbot-copy-btn"
                                onClick={() => handleCopy(`snip-${sIdx}`, snip.code)}
                              >
                                {copiedId === `snip-${sIdx}` ? (
                                  <>
                                    <Check size={12} aria-hidden="true" /> Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy size={12} aria-hidden="true" /> Copy
                                  </>
                                )}
                              </button>
                            </div>
                            <pre>
                              <code>{snip.code}</code>
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {state?.busy && (
          <div className="chatbot-message advisor chatbot-loading-msg" aria-live="polite">
            <Sparkle size={16} className="spin" aria-hidden="true" />
            <span>Analyzing frontend files and layout structure...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {state?.error && (
        <div className="chatbot-error-banner" role="alert">
          <Warning size={16} aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      )}

      <form className="chatbot-input-form" onSubmit={handleSubmit}>
        <div className="chatbot-input-row">
          <label htmlFor="chatbot-input" className="sr-only">
            Ask UI/UX question
          </label>
          <input
            id="chatbot-input"
            type="text"
            placeholder="Ask about spacing, visual hierarchy, layout..."
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            disabled={state?.busy}
          />
          <button
            type="submit"
            className="chatbot-submit-btn"
            disabled={!inputQuery.trim() || state?.busy}
            title="Send query"
          >
            <PaperPlaneRight size={16} aria-hidden="true" />
            <span className="sr-only">Send</span>
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              className="chatbot-clear-btn"
              onClick={() => send({ type: 'clear-chatbot-history' })}
              title="Clear chat history"
            >
              <Trash size={16} aria-hidden="true" />
              <span className="sr-only">Clear</span>
            </button>
          )}
        </div>
        <p className="chatbot-footer-note">
          Recommendation-only advisor. Does not modify files or execute IDE changes.
        </p>
      </form>
    </div>
  );
};
