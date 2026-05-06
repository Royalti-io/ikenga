import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface ParsedEmail {
  message_id: string;
  in_reply_to: string | null;
  from_address: string;
  to_address: string | null;
  cc_address: string | null;
  reply_to: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string; // ISO date
  inbox_source: string;
}

interface MboxConfig {
  /** How many bytes to read from the file. For newest-first files, reads from start. For oldest-first, reads from end. */
  chunkSize: number;
  /** If true, newest emails are at the start of the file (read from start). If false, read from end. */
  newestFirst: boolean;
  /** Only include emails on or after this date */
  sinceDate?: Date;
}

const THUNDERBIRD_PROFILE = process.env.THUNDERBIRD_PROFILE
  || "/home/nedjamez/snap/thunderbird/common/.thunderbird/0mbp5mp8.default";

export const MAILBOX_MAP: Record<
  string,
  { path: string; inboxSource: string; newestFirst: boolean }
> = {
  "royalti-inbox": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/server333.web-hosting.com/INBOX",
    ),
    inboxSource: "royalti.io",
    newestFirst: false,
  },
  "dixtrit-inbox": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/premium256.web-hosting.com/INBOX",
    ),
    inboxSource: "dixtrit.media",
    newestFirst: false,
  },
  "dixtrit-ci": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/premium256.web-hosting.com/INBOX.sbd/CI",
    ),
    inboxSource: "dixtrit.media",
    newestFirst: false,
  },
  "dixtrit-fuga": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/premium256.web-hosting.com/INBOX.sbd/FUGA",
    ),
    inboxSource: "dixtrit.media",
    newestFirst: false,
  },
  "dixtrit-merlin": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/premium256.web-hosting.com/INBOX.sbd/Merlin",
    ),
    inboxSource: "dixtrit.media",
    newestFirst: false,
  },
  "dixtrit-vertofx": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/premium256.web-hosting.com/INBOX.sbd/Verto FX",
    ),
    inboxSource: "dixtrit.media",
    newestFirst: false,
  },
  "dixtrit-sent": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/premium256.web-hosting.com/INBOX.sbd/Sent",
    ),
    inboxSource: "dixtrit.media",
    newestFirst: false,
  },
  "dixtrit-drafts": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/premium256.web-hosting.com/INBOX.sbd/Drafts",
    ),
    inboxSource: "dixtrit.media",
    newestFirst: false,
  },
  "royalti-sent": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/server333.web-hosting.com/INBOX.sbd/Sent",
    ),
    inboxSource: "royalti.io",
    newestFirst: false,
  },
  "royalti-drafts": {
    path: path.join(
      THUNDERBIRD_PROFILE,
      "ImapMail/server333.web-hosting.com/INBOX.sbd/Drafts",
    ),
    inboxSource: "royalti.io",
    newestFirst: false,
  },
};

/**
 * Decode MIME encoded words (=?charset?encoding?text?=)
 * Handles both Q (quoted-printable) and B (base64) encodings
 */
export function decodeMimeHeader(header: string): string {
  if (!header) return header;

  return header.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, _charset: string, encoding: string, text: string) => {
      if (encoding.toUpperCase() === "B") {
        try {
          return Buffer.from(text, "base64").toString("utf-8");
        } catch {
          return text;
        }
      }
      if (encoding.toUpperCase() === "Q") {
        const decoded = text
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
        return decoded;
      }
      return text;
    },
  );
}

/**
 * Generate a deterministic message_id from email metadata when Message-ID header is missing
 */
function generateMessageId(
  from: string,
  date: string,
  subject: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${from}|${date}|${subject}`)
    .digest("hex")
    .slice(0, 32);
  return `<generated-${hash}@thunderbird-sync>`;
}

/**
 * Extract the email address from a From/To header value
 * e.g. "John Doe <john@example.com>" -> "john@example.com"
 */
function extractAddress(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/<([^>]+)>/);
  return match ? match[1] : header.trim();
}

/**
 * Parse a Date header into an ISO string
 */
function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr.trim());
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * Extract plain text body from a raw email message
 * Handles nested multipart structures (e.g., multipart/related > multipart/alternative)
 * and quoted-printable/base64 encoding
 */
function extractBodyText(rawBody: string, depth: number = 0): string | null {
  if (!rawBody || depth > 5) return null; // Prevent infinite recursion

  // Check for multipart boundary (handles folded headers with tabs/spaces)
  const boundaryMatch = rawBody.match(
    /Content-Type:\s*multipart\/[^;]+;[\s\S]*?boundary="?([^"\r\n;]+)"?/i,
  );

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawBody.split(`--${boundary}`);

    // Skip part 0 (preamble before first boundary) - start from index 1
    // Find text/plain part (direct or nested)
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      // Get the first Content-Type in this part (the part's own type, not nested)
      const firstContentType = part.match(/^\s*Content-Type:\s*([^\r\n;]+)/i)?.[1]?.trim();

      if (firstContentType?.startsWith("text/plain")) {
        const text = extractTextFromPart(part);
        if (text) return text;
      }
      // Recurse into nested multipart
      if (firstContentType?.startsWith("multipart/")) {
        const nested = extractBodyText(part, depth + 1);
        if (nested) return nested;
      }
    }

    // Fall back to text/html if no plain text
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const firstContentType = part.match(/^\s*Content-Type:\s*([^\r\n;]+)/i)?.[1]?.trim();

      if (firstContentType?.startsWith("text/html")) {
        const html = extractTextFromPart(part);
        if (html) return stripHtml(html);
      }
      // Recurse into nested multipart for HTML fallback
      if (firstContentType?.startsWith("multipart/")) {
        const nested = extractBodyText(part, depth + 1);
        if (nested) return nested;
      }
    }
  }

  // Non-multipart: check content type
  if (/Content-Type:\s*text\/html/i.test(rawBody)) {
    const text = extractTextFromPart(rawBody);
    return text ? stripHtml(text) : null;
  }

  // Plain text (or unknown)
  return extractTextFromPart(rawBody);
}

/**
 * Extract and decode text content from a MIME part
 */
function extractTextFromPart(part: string): string | null {
  // Split headers from body - handle both CRLF (\r\n\r\n) and LF (\n\n)
  let headerEnd = part.indexOf("\r\n\r\n");
  let bodyOffset = 4;
  if (headerEnd === -1) {
    headerEnd = part.indexOf("\n\n");
    bodyOffset = 2;
  }
  if (headerEnd === -1) return null;

  const headers = part.slice(0, headerEnd);
  let body = part.slice(headerEnd + bodyOffset);

  // Check transfer encoding
  const isQuotedPrintable =
    /Content-Transfer-Encoding:\s*quoted-printable/i.test(headers);
  const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(headers);

  if (isQuotedPrintable) {
    body = decodeQuotedPrintable(body);
  } else if (isBase64) {
    try {
      body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch {
      // Keep as-is
    }
  }

  return body.trim() || null;
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "") // Soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a single raw mbox message into a ParsedEmail
 */
function parseMessage(
  raw: string,
  inboxSource: string,
): ParsedEmail | null {
  // Extract headers (everything before first empty line after the From_ line)
  const lines = raw.split("\n");

  // Skip the "From " envelope line
  let headerStart = 0;
  if (lines[0]?.startsWith("From ")) {
    headerStart = 1;
  }

  // Skip X-Mozilla-Status lines
  while (
    headerStart < lines.length &&
    lines[headerStart]?.startsWith("X-Mozilla-Status")
  ) {
    headerStart++;
  }

  // Collect headers (handle folded headers - lines starting with whitespace)
  const headerLines: string[] = [];
  let i = headerStart;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || line === "\r") break; // Empty line = end of headers

    if (line.startsWith(" ") || line.startsWith("\t")) {
      // Continuation of previous header
      if (headerLines.length > 0) {
        headerLines[headerLines.length - 1] += " " + line.trim();
      }
    } else {
      headerLines.push(line);
    }
  }

  // Parse headers into a map
  const headers: Record<string, string> = {};
  for (const hl of headerLines) {
    const colonIdx = hl.indexOf(":");
    if (colonIdx === -1) continue;
    const key = hl.slice(0, colonIdx).toLowerCase().trim();
    const value = hl.slice(colonIdx + 1).trim();
    // Only keep the first occurrence of each header
    if (!headers[key]) {
      headers[key] = value;
    }
  }

  const from = decodeMimeHeader(headers["from"] || "");
  const subject = decodeMimeHeader(headers["subject"] || "");
  const dateStr = headers["date"] || "";
  const messageId = headers["message-id"] || "";
  const inReplyTo = headers["in-reply-to"] || "";
  const to = decodeMimeHeader(headers["to"] || "");
  const cc = decodeMimeHeader(headers["cc"] || "");
  const replyTo = decodeMimeHeader(headers["reply-to"] || "");

  const receivedAt = parseDate(dateStr);
  if (!receivedAt) return null; // Can't store without a date

  const fromAddress = extractAddress(from);
  if (!fromAddress) return null; // Can't store without sender

  // Body is everything after the header separator
  const bodyRaw = lines.slice(i + 1).join("\n");
  const bodyText = extractBodyText(raw)?.slice(0, 2000) || null;

  const finalMessageId =
    messageId || generateMessageId(fromAddress, dateStr, subject);

  return {
    message_id: finalMessageId.replace(/^<|>$/g, ""), // Remove angle brackets for storage
    in_reply_to: inReplyTo ? inReplyTo.replace(/^<|>$/g, "") : null,
    from_address: fromAddress,
    to_address: extractAddress(to),
    cc_address: cc || null,
    reply_to: extractAddress(replyTo),
    subject: subject || null,
    body_text: bodyText,
    received_at: receivedAt,
    inbox_source: inboxSource,
  };
}

/**
 * Read and parse emails from an mbox file
 */
export function readMboxFile(
  filePath: string,
  inboxSource: string,
  config: MboxConfig,
): ParsedEmail[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`[thunderbird] Mailbox not found: ${filePath}`);
    return [];
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  if (fileSize === 0) {
    return [];
  }

  let buffer: Buffer;

  if (fileSize <= config.chunkSize) {
    // File is small enough to read entirely
    buffer = fs.readFileSync(filePath);
  } else if (config.newestFirst) {
    // Newest emails at start of file - read from beginning
    const fd = fs.openSync(filePath, "r");
    buffer = Buffer.alloc(config.chunkSize);
    fs.readSync(fd, buffer, 0, config.chunkSize, 0);
    fs.closeSync(fd);
  } else {
    // Oldest emails at start of file - read from end
    const fd = fs.openSync(filePath, "r");
    const offset = fileSize - config.chunkSize;
    buffer = Buffer.alloc(config.chunkSize);
    fs.readSync(fd, buffer, 0, config.chunkSize, offset);
    fs.closeSync(fd);
  }

  const content = buffer.toString("utf-8");

  // Split on mbox "From " separator lines
  // The pattern is: a line starting with "From " preceded by a newline (or start of string)
  const messages: string[] = [];
  const fromRegex = /^From .*\d{4}$/gm;
  let match: RegExpExecArray | null;
  const starts: number[] = [];

  while ((match = fromRegex.exec(content)) !== null) {
    starts.push(match.index);
  }

  for (let j = 0; j < starts.length; j++) {
    const start = starts[j];
    const end = j + 1 < starts.length ? starts[j + 1] : content.length;
    messages.push(content.slice(start, end));
  }

  const emails: ParsedEmail[] = [];
  const sinceTime = config.sinceDate?.getTime() ?? 0;

  for (const raw of messages) {
    const parsed = parseMessage(raw, inboxSource);
    if (!parsed) continue;

    // Filter by date
    if (sinceTime > 0) {
      const emailTime = new Date(parsed.received_at).getTime();
      if (emailTime < sinceTime) continue;
    }

    emails.push(parsed);
  }

  console.log(
    `[thunderbird] Parsed ${emails.length} emails from ${path.basename(filePath)} (${inboxSource})`,
  );
  return emails;
}

/**
 * Read emails from all configured mailboxes
 */
export function readAllMailboxes(config: {
  chunkSize?: number;
  sinceDate?: Date;
  mailboxes?: string[];
}): ParsedEmail[] {
  const chunkSize = config.chunkSize ?? 20 * 1024 * 1024; // 20MB default
  const allEmails: ParsedEmail[] = [];
  const mailboxKeys = config.mailboxes ?? Object.keys(MAILBOX_MAP);

  for (const key of mailboxKeys) {
    const mailbox = MAILBOX_MAP[key];
    if (!mailbox) {
      console.warn(`[thunderbird] Unknown mailbox: ${key}`);
      continue;
    }

    const emails = readMboxFile(mailbox.path, mailbox.inboxSource, {
      chunkSize,
      newestFirst: mailbox.newestFirst,
      sinceDate: config.sinceDate,
    });

    allEmails.push(...emails);
  }

  return allEmails;
}

/**
 * Read Sent mailboxes and return a set of message IDs the user has replied to.
 * Extracts In-Reply-To headers from sent messages.
 */
export function readSentMessageIds(config: {
  chunkSize?: number;
  sinceDate?: Date;
}): Set<string> {
  const sentMailboxes = ["royalti-sent", "dixtrit-sent"];
  const sentEmails = readAllMailboxes({
    ...config,
    mailboxes: sentMailboxes,
  });

  const repliedToIds = new Set<string>();
  for (const email of sentEmails) {
    if (email.in_reply_to) {
      repliedToIds.add(email.in_reply_to);
    }
  }

  console.log(
    `[thunderbird] Sent scan: ${sentEmails.length} sent emails, ${repliedToIds.size} replied-to IDs`,
  );
  return repliedToIds;
}
