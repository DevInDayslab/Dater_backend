const axios = require("axios");

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;

function normalizePhone(phoneNumber) {
  return String(phoneNumber || "").replace(/[^\d]/g, "");
}

async function sendOTP(phoneNumber) {
  if (!MSG91_AUTH_KEY) {
    throw new Error("MSG91_AUTH_KEY is required in environment variables");
  }
  if (!MSG91_TEMPLATE_ID) {
    throw new Error("MSG91_TEMPLATE_ID is required in environment variables");
  }

  const mobile = normalizePhone(phoneNumber);
  if (!mobile) {
    throw new Error("A valid phone number is required");
  }

  const response = await axios.get("https://control.msg91.com/api/v5/otp", {
    headers: {
      authkey: MSG91_AUTH_KEY,
    },
    params: {
      mobile,
      template_id: MSG91_TEMPLATE_ID,
      otp_length: 6,
    },
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

  const response = await axios.get("https://control.msg91.com/api/v5/otp/retry", {
    headers: {
      authkey: MSG91_AUTH_KEY,
    },
    params: {
      mobile,
      retrytype: "text",
    },
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

  const response = await axios.get("https://control.msg91.com/api/v5/otp/verify", {
    headers: {
      authkey: MSG91_AUTH_KEY,
    },
    params: {
      mobile,
      otp: normalizedOtp,
    },
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

  const response = await axios.post(
    "https://control.msg91.com/api/v5/widget/verifyAccessToken",
    {
      authkey: MSG91_AUTH_KEY,
      "access-token": normalizedToken,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  return response.data;
}

module.exports = {
  sendOTP,
  resendOTP,
  verifyOTP,
  verifyAccessToken,
};
