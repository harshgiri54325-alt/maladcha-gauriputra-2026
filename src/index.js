const API_VERSION = "2025-01-01";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });
}

function requestId() {
  return crypto.randomUUID();
}

function idempotencyKey() {
  return crypto.randomUUID();
}

function cleanName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function normalizePhone(value) {
  let phone = String(value ?? "").replace(/\D/g, "");

  if (phone.startsWith("91") && phone.length === 12) {
    phone = phone.slice(2);
  }

  return phone;
}

function validEmail(value) {
  if (!value) return "";

  const email = String(value)
    .trim()
    .slice(0, 160);

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : "";
}

function cashfreeBase(env) {
  return env.CASHFREE_ENVIRONMENT === "sandbox"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";
}

function cfHeaders(env) {
  return {
    "content-type": "application/json",
    "accept": "application/json",
    "x-api-version": API_VERSION,
    "x-client-id": env.CASHFREE_CLIENT_ID,
    "x-client-secret": env.CASHFREE_CLIENT_SECRET,
    "x-request-id": requestId(),
    "x-idempotency-key": idempotencyKey()
  };
}

async function cashfreeFetch(env, path, init = {}) {
  const response = await fetch(`${cashfreeBase(env)}${path}`, {
    ...init,
    headers: {
      ...cfHeaders(env),
      ...(init.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { response, data };
}

/* =========================
   CREATE CASHFREE ORDER
========================= */

async function createOrder(request, env) {
  if (
    !env.CASHFREE_CLIENT_ID ||
    !env.CASHFREE_CLIENT_SECRET
  ) {
    return json(
      {
        ok: false,
        error: "Payment gateway is not configured."
      },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid request."
      },
      400
    );
  }

  const name = cleanName(body.name);
  const phone = normalizePhone(body.phone);
  const email = validEmail(body.email);
  const amount = Number(body.amount);

  if (name.length < 2) {
    return json(
      {
        ok: false,
        error: "Please enter your full name."
      },
      400
    );
  }

  if (!/^[6-9]\d{9}$/.test(phone)) {
    return json(
      {
        ok: false,
        error: "Please enter a valid 10-digit Indian mobile number."
      },
      400
    );
  }

  if (
    !Number.isInteger(amount) ||
    amount < 101 ||
    amount > 1000000
  ) {
    return json(
      {
        ok: false,
        error: "Contribution must be between ₹101 and ₹10,00,000."
      },
      400
    );
  }

  const url = new URL(request.url);

  const orderId =
    `BAPPA_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  const returnUrl =
    `${url.origin}/?payment=return&order_id=${encodeURIComponent(orderId)}`;

  const notifyUrl =
    `${url.origin}/api/cashfree-webhook`;

  const payload = {
    order_id: orderId,
    order_amount: amount,
    order_currency: "INR",

    customer_details: {
      customer_id: `DONOR_${phone}`,
      customer_name: name,
      customer_phone: phone,
      ...(email
        ? { customer_email: email }
        : {})
    },

    order_meta: {
      return_url: returnUrl,
      notify_url: notifyUrl
    },

    order_note:
      "Voluntary contribution towards Bappa Seva 2026"
  };

  const { response, data } =
    await cashfreeFetch(
      env,
      "/orders",
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    );

  if (!response.ok) {
    console.error(
      "Cashfree create order failed",
      response.status,
      data
    );

    return json(
      {
        ok: false,
        error:
          data?.message ||
          data?.message_text ||
          "Unable to create payment order."
      },
      502
    );
  }

  return json({
    ok: true,
    order_id: data.order_id,
    payment_session_id:
      data.payment_session_id
  });
}

/* =========================
   SERVER-SIDE PAYMENT VERIFY
========================= */

async function getOrder(request, env) {
  const url = new URL(request.url);

  const orderId =
    url.searchParams.get("order_id")?.trim();

  if (
    !orderId ||
    !/^[A-Za-z0-9_-]{3,100}$/.test(orderId)
  ) {
    return json(
      {
        ok: false,
        error: "Invalid order ID."
      },
      400
    );
  }

  if (
    !env.CASHFREE_CLIENT_ID ||
    !env.CASHFREE_CLIENT_SECRET
  ) {
    return json(
      {
        ok: false,
        error: "Payment gateway is not configured."
      },
      500
    );
  }

  const { response, data } =
    await cashfreeFetch(
      env,
      `/orders/${encodeURIComponent(orderId)}`,
      {
        method: "GET"
      }
    );

  if (!response.ok) {
    return json(
      {
        ok: false,
        error: "Unable to verify payment."
      },
      502
    );
  }

  const paid =
    data.order_status === "PAID";

  return json({
    ok: true,
    paid,
    order_status: data.order_status,
    order_id: data.order_id,
    amount: data.order_amount,
    currency: data.order_currency,

    customer_name: paid
      ? data.customer_details?.customer_name || ""
      : "",

    customer_phone: paid
      ? data.customer_details?.customer_phone || ""
      : "",

    created_at: paid
      ? data.created_at || ""
      : "",

    certificate_number: paid
      ? `BAPPA-SEVA-${String(data.order_id).replace(/^BAPPA_/, "")}`
      : null
  });
}

/* =========================
   CASHFREE WEBHOOK VERIFY
========================= */

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return diff === 0;
}

function base64FromBytes(bytes) {
  let binary = "";

  const chunk = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunk
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunk)
    );
  }

  return btoa(binary);
}

async function hmacBase64(secret, message) {
  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message)
    );

  return base64FromBytes(
    new Uint8Array(signature)
  );
}

async function webhook(request, env) {
  if (!env.CASHFREE_CLIENT_SECRET) {
    return new Response(
      "Not configured",
      { status: 500 }
    );
  }

  const rawBody =
    await request.text();

  const timestamp =
    request.headers.get(
      "x-webhook-timestamp"
    ) || "";

  const signature =
    request.headers.get(
      "x-webhook-signature"
    ) || "";

  if (!timestamp || !signature) {
    return new Response(
      "Invalid signature",
      { status: 400 }
    );
  }

  const expected =
    await hmacBase64(
      env.CASHFREE_CLIENT_SECRET,
      timestamp + rawBody
    );

  if (
    !timingSafeEqual(
      expected,
      signature
    )
  ) {
    return new Response(
      "Invalid signature",
      { status: 401 }
    );
  }

  return new Response(
    "OK",
    { status: 200 }
  );
}

/* =========================
   MAIN WORKER
========================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (
        request.method === "POST" &&
        url.pathname === "/api/create-order"
      ) {
        return await createOrder(
          request,
          env
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/order-status"
      ) {
        return await getOrder(
          request,
          env
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/cashfree-webhook"
      ) {
        return await webhook(
          request,
          env
        );
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error:
            "Something went wrong on the server."
        },
        500
      );
    }
  }
};
