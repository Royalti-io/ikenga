import { useMemo } from 'react';
import { Markdown } from '@/components/markdown';

type BodyFormat = 'plain' | 'html' | 'markdown';

interface BodyPaneProps {
  body: string;
  format: BodyFormat;
  onChange: (next: string) => void;
  disabled?: boolean;
  textareaClassName?: string;
}

export function BodyPane({
  body,
  format,
  onChange,
  disabled,
  textareaClassName,
}: BodyPaneProps) {
  const rows = Math.max(12, body.split('\n').length + 2);

  return (
    <div className="bp-split">
      <div className="bp-source">
        <div className="bp-head">
          <span className="bp-label">Source</span>
          <span className="bp-fmt">{format}</span>
        </div>
        <textarea
          className={textareaClassName}
          value={body}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={rows}
          spellCheck={format === 'plain'}
        />
      </div>
      <div className="bp-preview">
        <div className="bp-head">
          <span className="bp-label">Preview</span>
        </div>
        <BodyPreview body={body} format={format} />
      </div>
    </div>
  );
}

function BodyPreview({ body, format }: { body: string; format: BodyFormat }) {
  if (format === 'html') {
    return <HtmlPreview html={body} />;
  }
  if (format === 'markdown') {
    return (
      <div className="bp-preview-md">
        <Markdown content={body} />
      </div>
    );
  }
  return <pre className="bp-preview-plain">{body}</pre>;
}

function HtmlPreview({ html }: { html: string }) {
  // Wrap fragment HTML in a minimal document with sensible defaults so emails
  // render close to what an inbox shows. iframe is sandboxed — no scripts,
  // no top navigation.
  const srcdoc = useMemo(() => {
    const looksLikeDoc = /<html[\s>]/i.test(html);
    if (looksLikeDoc) return html;
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
      html,body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111;background:#fff;}
      img{max-width:100%;height:auto;}
      a{color:#0a66c2;}
      table{border-collapse:collapse;}
    </style></head><body>${html}</body></html>`;
  }, [html]);

  return (
    <iframe
      title="Email HTML preview"
      className="bp-preview-iframe"
      srcDoc={srcdoc}
      sandbox="allow-same-origin"
    />
  );
}
