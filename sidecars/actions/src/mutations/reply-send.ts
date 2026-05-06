/**
 * reply-send <reply-id>
 *
 * Vendored port of the deleted /api/email-queue/replies/[id]/send route.
 * Sends an approved row from email_replies via Ruby's cPanel SMTP, threads
 * via In-Reply-To when the reply is linked to a message.
 *
 * Auth: the route used getAuthUser(); the sidecar runs with service-role
 * credentials so we substitute "sent_by: pa-actions" in send_result.
 *
 * Failure semantics: on send failure, the row is marked status='failed'
 * with error filled (matches old route).
 */

import nodemailer from "nodemailer";
import { supabase } from "../lib/supabase";
import { env, envOptional } from "../lib/env";
import { log } from "../lib/output";

interface ReplyRow {
  id: string;
  status: string;
  subject: string;
  body: string;
  body_format: "plain" | "html" | "markdown";
  from_name: string;
  from_email: string;
  recipients: Array<{ email: string }> | null;
  cc: string[] | null;
  reply_to_message_id: string | null;
  original_email?: { message_id?: string; subject?: string } | null;
}

export async function replySend(args: string[]): Promise<{ id: string; status: string; smtpMessageId?: string }> {
  const id = args[0];
  if (!id) throw new Error("reply-send requires a reply id arg");

  const sb = supabase();

  const { data: reply, error: fetchErr } = await sb
    .from("email_replies")
    .select(
      "id, status, subject, body, body_format, from_name, from_email, recipients, cc, reply_to_message_id, original_email:email_messages!reply_to_message_id(message_id, subject)",
    )
    .eq("id", id)
    .single<ReplyRow>();

  if (fetchErr || !reply) throw new Error(`reply not found: ${id}`);
  if (reply.status !== "approved") {
    throw new Error(`reply must be approved (got ${reply.status})`);
  }

  const host = env("RUBY_IMAP_HOST");
  const smtpUser = env("RUBY_IMAP_USER");
  const smtpPass = env("RUBY_IMAP_PASS");
  const port = Number(envOptional("RUBY_SMTP_PORT") ?? "465");

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const recipients = (reply.recipients ?? [])
    .map((r) => r.email)
    .filter((e): e is string => Boolean(e));
  if (recipients.length === 0) throw new Error("no recipients");

  const cc = Array.isArray(reply.cc) ? reply.cc : [];
  const orig = reply.original_email ?? null;
  const inReplyTo = orig?.message_id;
  const references = orig?.message_id;
  let subject = reply.subject;
  if (orig?.subject && !subject.toLowerCase().startsWith("re:")) {
    subject = `Re: ${orig.subject}`;
  }

  try {
    const info = await transporter.sendMail({
      from: `"${reply.from_name}" <${reply.from_email}>`,
      to: recipients,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      text: reply.body_format === "plain" ? reply.body : undefined,
      html: reply.body_format === "html" ? reply.body : undefined,
      inReplyTo,
      references,
    });

    const smtpMessageId = info.messageId ?? `<sent-${Date.now()}@${host}>`;

    const { error: updateErr } = await sb
      .from("email_replies")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        send_result: {
          smtp_message_id: smtpMessageId,
          recipients,
          cc,
          sent_via: "smtp",
          sender: "pa-actions reply-send",
          sent_by: "pa-actions",
        },
      })
      .eq("id", id);

    if (updateErr) throw new Error(`sent but failed to update row: ${updateErr.message}`);

    log(`reply-send: ${id} ok → ${recipients.join(", ")}`);
    return { id, status: "sent", smtpMessageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb
      .from("email_replies")
      .update({ status: "failed", error: msg })
      .eq("id", id);
    throw new Error(`smtp send failed: ${msg}`);
  }
}
