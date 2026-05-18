require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || "demo";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use("/audio", express.static(path.join(__dirname, "public", "audio")));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function brandExists(brand) {
  const brandPath = path.join(__dirname, "public", "audio", brand);
  return fs.existsSync(brandPath);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      store_name TEXT,
      client_name TEXT,
      client_phone TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT 'demo',
      status TEXT NOT NULL DEFAULT 'queued',
      call_status TEXT NOT NULL DEFAULT 'pending',
      call_after TIMESTAMP NOT NULL,
      called_at TIMESTAMP NULL,
      twilio_call_sid TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_order_id_unique
    ON orders (order_id);
  `);

  console.log("Database ready: orders table is available");
}

function audioUrl(brand, fileName) {
  return `${process.env.BASE_URL}/audio/${brand}/${fileName}`;
}

app.get("/", (req, res) => {
  res.send("AWF call bot is running");
});

app.get("/orders", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
      LIMIT 100
    `);

    return res.json({
      ok: true,
      count: result.rows.length,
      orders: result.rows,
    });
  } catch (error) {
    console.error("GET ORDERS ERROR:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/orders/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE order_id = $1
      LIMIT 1
      `,
      [orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: `Comanda cu orderId "${orderId}" nu a fost găsită.`,
      });
    }

    return res.json({
      ok: true,
      order: result.rows[0],
    });
  } catch (error) {
    console.error("GET ORDER BY ID ERROR:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/new-order", async (req, res) => {
  try {
    const {
      orderId,
      storeName,
      clientName,
      phone,
      brand = DEFAULT_BRAND,
    } = req.body;

    if (!orderId || !phone) {
      return res.status(400).json({
        ok: false,
        error: 'Lipsesc câmpuri obligatorii: "orderId" și/sau "phone"',
      });
    }

    const existing = await pool.query(
      `SELECT * FROM orders WHERE order_id = $1 LIMIT 1`,
      [orderId]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        ok: false,
        error: `Comanda cu orderId "${orderId}" există deja.`,
        order: existing.rows[0],
      });
    }

    const callAfter = new Date(Date.now() + 5 * 60 * 1000);

    const result = await pool.query(
      `
      INSERT INTO orders (
        order_id,
        store_name,
        client_name,
        client_phone,
        brand,
        status,
        call_status,
        call_after
      )
      VALUES ($1, $2, $3, $4, $5, 'queued', 'pending', $6)
      RETURNING *;
      `,
      [orderId, storeName || null, clientName || null, phone, brand, callAfter]
    );

    console.log("NEW ORDER SAVED:", {
      orderId,
      phone,
      brand,
      callAfter,
    });

    return res.json({
      ok: true,
      message: "Comanda a fost salvată și programată pentru apel.",
      order: result.rows[0],
    });
  } catch (error) {
    console.error("NEW ORDER ERROR:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/reset-orders", async (req, res) => {
  try {
    await pool.query(`DELETE FROM orders;`);

    return res.json({
      ok: true,
      message: "Toate comenzile de test au fost șterse.",
    });
  } catch (error) {
    console.error("RESET ORDERS ERROR:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/call", async (req, res) => {
  try {
    const to = req.body.to;
    const brand = req.body.brand || DEFAULT_BRAND;

    if (!to) {
      return res.status(400).json({
        ok: false,
        error: 'Lipsește "to"'
      });
    }

    if (!brandExists(brand)) {
      return res.status(400).json({
        ok: false,
        error: `Brand-ul "${brand}" nu există în public/audio/${brand}`
      });
    }

    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BASE_URL}/voice?brand=${encodeURIComponent(brand)}`,
      method: "POST",
      statusCallback: `${process.env.BASE_URL}/status?brand=${encodeURIComponent(brand)}`,
      statusCallbackMethod: "POST"
    });

    return res.json({
      ok: true,
      message: "Call started",
      brand,
      callSid: call.sid
    });
  } catch (error) {
    console.error("CALL ERROR:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/voice", (req, res) => {
  const brand = req.query.brand || DEFAULT_BRAND;
  const orderId = req.query.orderId || "";
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech dtmf",
    numDigits: 1,
    timeout: 6,
    speechTimeout: "auto",
    action: `/handle-response?brand=${encodeURIComponent(brand)}&orderId=${encodeURIComponent(orderId)}`,
    method: "POST",
    language: "ro-RO"
  });

  gather.play(audioUrl(brand, "confirmare-comanda.mp3"));
  twiml.play(audioUrl(brand, "fara-raspuns.mp3"));
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});


app.post("/handle-response", async (req, res) => {
  const brand = req.query.brand || DEFAULT_BRAND;
  const orderId = req.query.orderId || null;
  const digits = req.body.Digits || "";
  const speech = (req.body.SpeechResult || "").toLowerCase().trim();

  let result = "unknown";

  if (
    digits === "1" ||
    speech.includes("confirm comanda") ||
    speech === "confirm" ||
    speech.includes("confirm")
  ) {
    result = "confirmed";
  } else if (
    digits === "2" ||
    speech.includes("anulez comanda") ||
    speech === "anulez" ||
    speech.includes("anulez")
  ) {
    result = "cancelled";
  }

  console.log("CLIENT RESPONSE:", { brand, orderId, digits, speech, result });

  try {
    if (orderId) {
      await pool.query(
        `
        UPDATE orders
        SET status = $2,
            call_status = $2,
            updated_at = NOW()
        WHERE order_id = $1
        `,
        [orderId, result]
      );
    }
  } catch (error) {
    console.error("HANDLE RESPONSE DB ERROR:", error.message);
  }

  const twiml = new twilio.twiml.VoiceResponse();

  if (result === "confirmed") {
    twiml.play(audioUrl(brand, "confirmat.mp3"));
  } else if (result === "cancelled") {
    twiml.play(audioUrl(brand, "anulat.mp3"));
  } else {
    twiml.play(audioUrl(brand, "fallback.mp3"));
  }

  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/status", async (req, res) => {
  const brand = req.query.brand || DEFAULT_BRAND;
  const orderId = req.query.orderId || null;

  console.log("CALL STATUS:", {
    brand,
    orderId,
    callStatus: req.body.CallStatus,
    callSid: req.body.CallSid
  });

  try {
    if (orderId) {
      await pool.query(
        `
        UPDATE orders
        SET call_status = $2,
            twilio_call_sid = COALESCE($3, twilio_call_sid),
            updated_at = NOW()
        WHERE order_id = $1
        `,
        [orderId, req.body.CallStatus || "unknown", req.body.CallSid || null]
      );
    }
  } catch (error) {
    console.error("STATUS DB ERROR:", error.message);
  }

  res.sendStatus(200);
});

async function processQueuedOrders() {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE status = 'queued'
        AND call_after <= NOW()
      ORDER BY call_after ASC
      LIMIT 10;
      `
    );

    for (const order of result.rows) {
      try {
        console.log("PROCESSING ORDER:", order.order_id, order.client_phone, order.brand);

        if (!brandExists(order.brand)) {
          console.error(`Brand-ul "${order.brand}" nu există pentru comanda ${order.order_id}`);
          await pool.query(
            `
            UPDATE orders
            SET status = 'failed',
                call_status = 'brand_missing',
                updated_at = NOW()
            WHERE id = $1
            `,
            [order.id]
          );
          continue;
        }

        const call = await client.calls.create({
          to: order.client_phone,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: `${process.env.BASE_URL}/voice?brand=${encodeURIComponent(order.brand)}&orderId=${encodeURIComponent(order.order_id)}`,
          method: "POST",
          statusCallback: `${process.env.BASE_URL}/status?brand=${encodeURIComponent(order.brand)}&orderId=${encodeURIComponent(order.order_id)}`,
          statusCallbackMethod: "POST"
        });

        await pool.query(
          `
          UPDATE orders
          SET status = 'calling',
              call_status = 'started',
              called_at = NOW(),
              twilio_call_sid = $2,
              updated_at = NOW()
          WHERE id = $1
          `,
          [order.id, call.sid]
        );

        console.log("CALL STARTED FOR ORDER:", order.order_id, call.sid);
      } catch (error) {
        console.error("PROCESS ORDER ERROR:", order.order_id, error.message);

        await pool.query(
          `
          UPDATE orders
          SET status = 'failed',
              call_status = 'call_error',
              updated_at = NOW()
          WHERE id = $1
          `,
          [order.id]
        );
      }
    }
  } catch (error) {
    console.error("QUEUE WORKER ERROR:", error.message);
  }
}async function processQueuedOrders() {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE status = 'queued'
        AND call_after <= NOW()
      ORDER BY call_after ASC
      LIMIT 10;
      `
    );

    for (const order of result.rows) {
      try {
        console.log("PROCESSING ORDER:", order.order_id, order.client_phone, order.brand);

        if (!brandExists(order.brand)) {
          console.error(`Brand-ul "${order.brand}" nu există pentru comanda ${order.order_id}`);
          await pool.query(
            `
            UPDATE orders
            SET status = 'failed',
                call_status = 'brand_missing',
                updated_at = NOW()
            WHERE id = $1
            `,
            [order.id]
          );
          continue;
        }

        const call = await client.calls.create({
          to: order.client_phone,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: `${process.env.BASE_URL}/voice?brand=${encodeURIComponent(order.brand)}&orderId=${encodeURIComponent(order.order_id)}`,
          method: "POST",
          statusCallback: `${process.env.BASE_URL}/status?brand=${encodeURIComponent(order.brand)}&orderId=${encodeURIComponent(order.order_id)}`,
          statusCallbackMethod: "POST"
        });

        await pool.query(
          `
          UPDATE orders
          SET status = 'calling',
              call_status = 'started',
              called_at = NOW(),
              twilio_call_sid = $2,
              updated_at = NOW()
          WHERE id = $1
          `,
          [order.id, call.sid]
        );

        console.log("CALL STARTED FOR ORDER:", order.order_id, call.sid);
      } catch (error) {
        console.error("PROCESS ORDER ERROR:", order.order_id, error.message);

        await pool.query(
          `
          UPDATE orders
          SET status = 'failed',
              call_status = 'call_error',
              updated_at = NOW()
          WHERE id = $1
          `,
          [order.id]
        );
      }
    }
  } catch (error) {
    console.error("QUEUE WORKER ERROR:", error.message);
  }
}

async function startServer() {
  try {
    await initDb();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    setInterval(processQueuedOrders, 30000);
    console.log("Queue worker started: checking queued orders every 30 seconds");
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();