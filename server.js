require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_BRAND = process.env.DEFAULT_BRAND || "demo";

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

function audioUrl(brand, fileName) {
  return `${process.env.BASE_URL}/audio/${brand}/${fileName}`;
}

app.get("/", (req, res) => {
  res.send("AWF call bot is running");
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
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech dtmf",
    numDigits: 1,
    timeout: 6,
    speechTimeout: "auto",
    action: `/handle-response?brand=${encodeURIComponent(brand)}`,
    method: "POST",
    language: "ro-RO"
  });

  gather.play(audioUrl(brand, "confirmare-comanda.mp3"));
  twiml.play(audioUrl(brand, "fara-raspuns.mp3"));
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/handle-response", (req, res) => {
  const brand = req.query.brand || DEFAULT_BRAND;
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

  console.log("RASPUNS CLIENT:", { brand, digits, speech, result });

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

app.post("/status", (req, res) => {
  const brand = req.query.brand || DEFAULT_BRAND;
  console.log("CALL STATUS:", {
    brand,
    callStatus: req.body.CallStatus,
    callSid: req.body.CallSid
  });
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});