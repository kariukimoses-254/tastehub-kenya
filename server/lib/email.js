const nodemailer = require('nodemailer');
const { issueLabel } = require('./deliveries');

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function money(value) {
  return `KSh ${Number(value || 0).toLocaleString('en-KE')}`;
}

function formatDate(value) {
  if (!value) return 'To be confirmed';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'To be confirmed';
  return date.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

function itemLines(delivery) {
  const items = Array.isArray(delivery.items) ? delivery.items : [];
  if (!items.length) return 'Your order';
  return items.map((item) => `${item.quantity} x ${item.name}`).join(', ');
}

function confirmationUrl(settings, delivery) {
  return `${settings.publicBaseUrl}/confirm.html?token=${encodeURIComponent(delivery.token)}`;
}

function layout(settings, title, paragraphs, callToAction) {
  const body = paragraphs.map((paragraph) => `<p style="margin:0 0 12px">${paragraph}</p>`).join('');
  const button = callToAction
    ? `<p style="margin:22px 0"><a href="${escapeHtml(callToAction.url)}" style="background:#ed7c2d;color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">${escapeHtml(callToAction.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f7f3ef;font-family:Inter,Arial,sans-serif;color:#21170f">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#21170f;color:#fff;padding:18px 22px;border-radius:14px 14px 0 0">
      <strong style="font-size:18px">TasteHub Kenya</strong>
    </div>
    <div style="background:#fff;padding:24px 22px;border-radius:0 0 14px 14px">
      <h1 style="font-size:21px;margin:0 0 16px">${escapeHtml(title)}</h1>
      ${body}
      ${button}
      <p style="margin:22px 0 0;font-size:12px;color:#766b62">Questions? Reply to this email or contact your branch. This message was sent by TasteHub Kenya.</p>
    </div>
  </div>
</body></html>`;
}

function deliverySummary(delivery) {
  return [
    `Order: #${delivery.orderId}`,
    `Branch: ${delivery.branch}`,
    `Items: ${itemLines(delivery)}`,
    `Total: ${money(delivery.totalKes)}`,
    delivery.deliveryAddress ? `Deliver to: ${delivery.deliveryAddress}` : null,
    delivery.driver ? `Driver: ${delivery.driver.name || delivery.driver.email}` : null,
  ].filter(Boolean);
}

function nextSchedule(delivery) {
  return [
    `Next delivery ready: ${formatDate(delivery.nextReadyAt)}`,
    `Next delivery date: ${formatDate(delivery.nextDeliveryAt)}`,
  ];
}

function arrivalEmail(settings, delivery) {
  const url = confirmationUrl(settings, delivery);
  const subject = `Order #${delivery.orderId} is arriving - confirm your delivery`;
  const text = [
    `Hello ${delivery.customer.name},`,
    '',
    `Your TasteHub delivery for order #${delivery.orderId} has arrived.`,
    'Please check your items and confirm the delivery using this secure link:',
    url,
    '',
    ...deliverySummary(delivery),
    '',
    'If something is wrong or an item is damaged, use the same link to report it.',
    '',
    'Thank you for choosing TasteHub Kenya.',
  ].join('\n');
  const html = layout(
    settings,
    'Your delivery has arrived',
    [
      `Hello ${escapeHtml(delivery.customer.name)},`,
      `Your driver has arrived with order <b>#${delivery.orderId}</b>. Please check your items before confirming.`,
      `<span style="color:#766b62">${escapeHtml(deliverySummary(delivery).join(' · '))}</span>`,
      'If an item is wrong, missing or damaged, use the same button and choose “Report a problem”.',
    ],
    { url, label: 'Confirm delivery' }
  );
  return { subject, text, html };
}

function confirmationEmail(settings, delivery) {
  const subject = `Delivery confirmed - Order #${delivery.orderId}`;
  const next = nextSchedule(delivery);
  const text = [
    `Hello ${delivery.customer.name},`,
    '',
    `Thank you. Order #${delivery.orderId} was confirmed delivered on ${formatDate(delivery.confirmedAt)}.`,
    '',
    ...deliverySummary(delivery),
    '',
    'Next delivery',
    ...next,
    '',
    'We will send another confirmation when the next order is ready.',
    '',
    'Thank you for choosing TasteHub Kenya.',
  ].join('\n');
  const html = layout(
    settings,
    'Delivery confirmed',
    [
      `Hello ${escapeHtml(delivery.customer.name)},`,
      `Order <b>#${delivery.orderId}</b> was confirmed delivered on ${escapeHtml(formatDate(delivery.confirmedAt))}.`,
      `<span style="color:#766b62">${escapeHtml(deliverySummary(delivery).join(' · '))}</span>`,
      `<b>Next delivery</b><br>Ready: ${escapeHtml(next[0].replace('Next delivery ready: ', ''))}<br>Delivered: ${escapeHtml(next[1].replace('Next delivery date: ', ''))}`,
    ]
  );
  return { subject, text, html };
}

function nextDeliveryEmail(settings, delivery) {
  const subject = `Your next TasteHub delivery - Order #${delivery.orderId}`;
  const next = nextSchedule(delivery);
  const text = [
    `Hello ${delivery.customer.name},`,
    '',
    `Here is the schedule for your next delivery from ${delivery.branch}.`,
    '',
    ...next,
    '',
    `Reference order: #${delivery.orderId}`,
    '',
    'Thank you for choosing TasteHub Kenya.',
  ].join('\n');
  const html = layout(
    settings,
    'Your next delivery is scheduled',
    [
      `Hello ${escapeHtml(delivery.customer.name)},`,
      `Here is the schedule for your next delivery from <b>${escapeHtml(delivery.branch)}</b>.`,
      `<b>Ready:</b> ${escapeHtml(next[0].replace('Next delivery ready: ', ''))}<br><b>Delivered:</b> ${escapeHtml(next[1].replace('Next delivery date: ', ''))}`,
      `Reference order: <b>#${delivery.orderId}</b>`,
    ]
  );
  return { subject, text, html };
}

function issueAckEmail(settings, delivery) {
  const subject = `We received your delivery report - Order #${delivery.orderId}`;
  const label = issueLabel(delivery.issue && delivery.issue.type);
  const note = delivery.issue && delivery.issue.note ? delivery.issue.note : '';
  const text = [
    `Hello ${delivery.customer.name},`,
    '',
    `We received your report for order #${delivery.orderId}: ${label}.`,
    note ? `Your message: ${note}` : null,
    '',
    'Headquarters and the branch have been notified and will contact you to put it right.',
    '',
    'Thank you for telling us.',
  ].filter(Boolean).join('\n');
  const html = layout(
    settings,
    'We received your report',
    [
      `Hello ${escapeHtml(delivery.customer.name)},`,
      `We received your report for order <b>#${delivery.orderId}</b>: <b>${escapeHtml(label)}</b>.`,
      note ? `Your message: ${escapeHtml(note)}` : '',
      'Headquarters and the branch have been notified and will contact you to put it right.',
      'Thank you for telling us.',
    ].filter(Boolean)
  );
  return { subject, text, html };
}

function createEmailer({ pool, settings, logger = console }) {
  const smtp = settings.smtp || {};
  const transport = smtp.host
    ? nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: Boolean(smtp.secure),
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      })
    : null;

  async function send({ to, subject, text, html, kind, orderId = null }) {
    if (!to) return { status: 'skipped', reason: 'No customer email on file' };
    const [result] = await pool.execute(
      `INSERT INTO email_outbox (order_id, recipient, subject, body, kind, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
      [orderId, to, subject, text, kind]
    );
    const id = result.insertId;

    if (!transport) {
      logger.info(`[email:logged] ${kind} -> ${to} :: ${subject}`);
      await pool.execute(
        "UPDATE email_outbox SET status = 'logged', sent_at = NOW() WHERE id = ?",
        [id]
      );
      return { id, status: 'logged' };
    }

    try {
      await transport.sendMail({ from: smtp.from, to, subject, text, html });
      await pool.execute(
        "UPDATE email_outbox SET status = 'sent', sent_at = NOW() WHERE id = ?",
        [id]
      );
      return { id, status: 'sent' };
    } catch (error) {
      logger.error(`[email] failed to send ${kind} to ${to}: ${error.message}`);
      await pool.execute(
        "UPDATE email_outbox SET status = 'failed', error = ? WHERE id = ?",
        [String(error.message || 'Send failed').slice(0, 500), id]
      );
      return { id, status: 'failed', error: error.message };
    }
  }

  function arrival(delivery) {
    return send({ to: delivery.customer.email, orderId: delivery.orderId, kind: 'arrival', ...arrivalEmail(settings, delivery) });
  }

  function confirmation(delivery) {
    return send({ to: delivery.customer.email, orderId: delivery.orderId, kind: 'delivery_confirmation', ...confirmationEmail(settings, delivery) });
  }

  function nextDelivery(delivery) {
    return send({ to: delivery.customer.email, orderId: delivery.orderId, kind: 'next_delivery', ...nextDeliveryEmail(settings, delivery) });
  }

  function issueAcknowledgement(delivery) {
    return send({ to: delivery.customer.email, orderId: delivery.orderId, kind: 'issue_acknowledgement', ...issueAckEmail(settings, delivery) });
  }

  return { send, arrival, confirmation, nextDelivery, issueAcknowledgement, enabled: Boolean(transport) };
}

module.exports = { createEmailer, confirmationUrl, formatDate };
