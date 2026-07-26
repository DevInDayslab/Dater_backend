const axios = require("axios");
const https = require("https");
const http = require("http");
const { debugLog, maskPhoneDigits } = require("../utils/serverDebugLog");

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const DEFAULT_TEMPLATE_ID = "69e4d1cc95281f220a0eee92";
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID || DEFAULT_TEMPLATE_ID;

/** Reuse TLS sessions to Msg91 control API (cuts repeated handshake latency). */
const msg91HttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 50,
});
const msg91HttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 50,
});

const msg91AxiosConfig = {
  httpsAgent: msg91HttpsAgent,
  httpAgent: msg91HttpAgent,
};

function normalizePhone(phoneNumber) {
  return String(phoneNumber || "").replace(/[^\d]/g, "");
}

async function sendOTP(phoneNumber) {
  if (!MSG91_AUTH_KEY) {
    throw new Error("MSG91_AUTH_KEY is required in environment variables");
  }

  const mobile = normalizePhone(phoneNumber);
  if (!mobile) {
    throw new Error("A valid phone number is required");
  }
  debugLog("msg91_send_otp_start", {
    phone: maskPhoneDigits(mobile),
    templateId: MSG91_TEMPLATE_ID,
  });

  const response = await axios.get("https://control.msg91.com/api/v5/otp", {
    ...msg91AxiosConfig,
    headers: {
      authkey: MSG91_AUTH_KEY,
    },
    params: {
      mobile,
      template_id: MSG91_TEMPLATE_ID,
      otp_length: 6,
    },
  });
  debugLog("msg91_send_otp_response", {
    phone: maskPhoneDigits(mobile),
    templateId: MSG91_TEMPLATE_ID,
    type: response.data?.type,
    message: response.data?.message,
    requestId: response.data?.request_id || response.data?.reqId || null,
  });

  return response.data;
}

async function resendOTP(phoneNumber) {
  if (!MSG91_AUTH_KEY) {
    throw new Error("MSG91_AUTH_KEY is required in environment variables");
  }

  const mobile = normalizePhone(phoneNumber);
  if (!mobile) {
    throw new Error("A valid phone number is required");
  }
  debugLog("msg91_resend_otp_start", { phone: maskPhoneDigits(mobile) });

  const response = await axios.get("https://control.msg91.com/api/v5/otp/retry", {
    ...msg91AxiosConfig,
    headers: {
      authkey: MSG91_AUTH_KEY,
    },
    params: {
      mobile,
      retrytype: "text",
    },
  });
  debugLog("msg91_resend_otp_response", {
    phone: maskPhoneDigits(mobile),
    type: response.data?.type,
    message: response.data?.message,
  });

  return response.data;
}

async function verifyOTP(phoneNumber, otp) {
  if (!MSG91_AUTH_KEY) {
    throw new Error("MSG91_AUTH_KEY is required in environment variables");
  }

  const mobile = normalizePhone(phoneNumber);
  const normalizedOtp = String(otp || "").trim();

  if (!mobile || normalizedOtp.length !== 6) {
    throw new Error("A valid phone number and 6-digit OTP are required");
  }
  debugLog("msg91_verify_otp_start", { phone: maskPhoneDigits(mobile), otpLength: normalizedOtp.length });

  const response = await axios.get("https://control.msg91.com/api/v5/otp/verify", {
    ...msg91AxiosConfig,
    headers: {
      authkey: MSG91_AUTH_KEY,
    },
    params: {
      mobile,
      otp: normalizedOtp,
    },
  });
  debugLog("msg91_verify_otp_response", {
    phone: maskPhoneDigits(mobile),
    type: response.data?.type,
    message: response.data?.message,
  });

  return response.data;
}

async function verifyAccessToken(accessToken) {
  if (!MSG91_AUTH_KEY) {
    throw new Error("MSG91_AUTH_KEY is required in environment variables");
  }

  const normalizedToken = String(accessToken || "").trim();
  if (!normalizedToken) {
    throw new Error("A valid access token is required");
  }
  debugLog("msg91_verify_widget_token_start", { tokenChars: normalizedToken.length });

  const response = await axios.post(
    "https://control.msg91.com/api/v5/widget/verifyAccessToken",
    {
      authkey: MSG91_AUTH_KEY,
      "access-token": normalizedToken,
    },
    {
      ...msg91AxiosConfig,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );
  debugLog("msg91_verify_widget_token_response", {
    type: response.data?.type,
    message: response.data?.message,
  });

  return response.data;
}

module.exports = {
  sendOTP,
  resendOTP,
  verifyOTP,
  verifyAccessToken,
};
