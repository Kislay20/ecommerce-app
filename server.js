const express = require("express");
const cors = require("cors");
const uaParser = require('ua-parser-js');
const {
  StandardCheckoutClient,
  Env,
  StandardCheckoutPayRequest,
} = require("pg-sdk-node");
const { randomUUID } = require("crypto");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail"); // For sending emails

// --- CONFIGURATION ---
require("dotenv").config();

const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === "production";

// --- Email Configuration ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const SENDER_EMAIL = "kislayjha844@gmail.com"; // IMPORTANT: Change to your SendGrid verified sender
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// --- Environment-specific URLs (from .env) ---
const BACKEND_URL = isProduction
  ? process.env.PROD_BACKEND_URL
  : process.env.DEV_BACKEND_URL;
const FRONTEND_URL = isProduction
  ? process.env.PROD_FRONTEND_URL
  : process.env.DEV_FRONTEND_URL;

// --- Securely initialize Firebase Admin SDK ---
let serviceAccount;
if (isProduction) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_JSON is not set.");
    process.exit(1);
  }
} else {
  serviceAccount = require("./firebase-service-account.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// --- INITIALIZATION ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Initialize PhonePe client ---
// This is forced to SANDBOX for your presentation demo.
// Change back to `isProduction ? Env.PRODUCTION : Env.SANDBOX` for real live payments.
const phonepeEnv = Env.SANDBOX;

const phonepeClient = StandardCheckoutClient.getInstance(
  process.env.PHONEPE_CLIENT_ID,
  process.env.PHONEPE_CLIENT_SECRET,
  1, // Client Version
  phonepeEnv
);

console.log(`--- Server starting in ${isProduction ? "PRODUCTION" : "DEVELOPMENT"} mode ---`);
console.log(`--- PhonePe environment is set to: ${phonepeEnv} ---`);

// --- EMAIL HELPER FUNCTIONS ---

const createOrderConfirmationHtml = (order) => {
  const productsHtml = order.products.map(p => `
    <tr>
      <td style="padding: 8px; border: 1px solid #ddd;">${p.name}</td>
      <td style="padding: 8px; border: 1px solid #ddd;">${p.quantity}</td>
      <td style="padding: 8px; border: 1px solid #ddd;">₹${p.price.toLocaleString()}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6;">
      <h2>Your Order #${order.merchantOrderId} is Confirmed!</h2>
      <p>Thank you for your purchase. We've received your order and are getting it ready.</p>
      <h3>Order Summary</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead style="background-color: #f2f2f2;">
          <tr>
            <th style="padding: 8px; border: 1px solid #ddd;">Product</th>
            <th style="padding: 8px; border: 1px solid #ddd;">Quantity</th>
            <th style="padding: 8px; border: 1px solid #ddd;">Price</th>
          </tr>
        </thead>
        <tbody>${productsHtml}</tbody>
      </table>
      <h3 style="text-align: right;">Total: ₹${order.amount.toLocaleString()}</h3>
      <p>We'll notify you again once your order has shipped.</p>
    </div>
  `;
};

const createAdminNotificationHtml = (order) => {
    const productsHtml = order.products.map(p => `<li>${p.name} (x${p.quantity}) - ₹${p.price.toLocaleString()}</li>`).join('');
    const shipping = order.shippingDetails;
    return `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>🔔 New Order Received: #${order.merchantOrderId}</h2>
        <p>A new order has been placed on the website.</p>
        <ul>
          <li><strong>Order ID:</strong> ${order.merchantOrderId}</li>
          <li><strong>Total Amount:</strong> ₹${order.amount.toLocaleString()}</li>
          <li><strong>Customer Email:</strong> ${shipping.email}</li>
        </ul>
        <h3>Shipping Details</h3>
        <p>
          ${shipping.name}<br>
          ${shipping.address}<br>
          ${shipping.city}, ${shipping.state} ${shipping.zip}<br>
          Phone: ${shipping.phone}
        </p>
        <h3>Items Ordered</h3>
        <ul>${productsHtml}</ul>
      </div>
    `;
};


// --- API ENDPOINTS ---

/**
 * @route   POST /api/pay
 * @desc    Initiate a payment with PhonePe
 */
app.post("/api/pay", async (req, res) => {
  try {
    const { amount, products, shippingDetails, userId } = req.body;

    if (!amount || !products || !shippingDetails || !userId) {
      return res.status(400).json({ success: false, message: "Missing required payment data." });
    }

    const merchantOrderId = `M-${randomUUID().slice(0, 6)}`;
    const redirectUrl = `${FRONTEND_URL}/payment-status/${merchantOrderId}`;
    const callbackUrl = `${BACKEND_URL}/api/callback`;

    await db.collection("orders").doc(merchantOrderId).set({
      merchantOrderId,
      userId,
      amount,
      products,
      shippingDetails, // This now includes the user's email
      status: "PENDING",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const payRequest = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantOrderId)
      .amount(amount * 100) // amount in paise
      .redirectUrl(redirectUrl)
      .build();

    payRequest.callbackUrl = callbackUrl;
    payRequest.merchantUserId = userId;
    payRequest.mobileNumber = shippingDetails.phone;

    const response = await phonepeClient.pay(payRequest);

    if (response && response.orderId) {
      await db.collection("orders").doc(merchantOrderId).update({
        merchantTransactionId: response.orderId,
      });
    }

    res.json({ success: true, redirectUrl: response.redirectUrl, merchantOrderId });
  } catch (error) {
    console.error("Error in /api/pay:", error);
    res.status(500).json({ success: false, message: "An error occurred while initiating payment." });
  }
});

/**
 * @route   POST /api/callback
 * @desc    PhonePe Server-to-Server Callback
 */
app.post("/api/callback", async (req, res) => {
  try {
    const callbackResponse = req.body;
    const xVerifyHeader = req.headers["x-verify"];

    if (!callbackResponse || !xVerifyHeader) {
      return res.status(400).send({ success: false, message: "Invalid callback" });
    }

    const decodedResponse = JSON.parse(Buffer.from(callbackResponse.response, "base64").toString("utf8"));
    const merchantOrderId = decodedResponse.data.merchantOrderId;
    const orderRef = db.collection("orders").doc(merchantOrderId);

    if (decodedResponse.success) {
      console.log(`Payment successful for ${merchantOrderId}.`);
      await orderRef.update({
        status: "COMPLETED",
        phonepeTransactionId: decodedResponse.data.transactionId,
        paymentState: decodedResponse.code,
      });

      // --- SEND EMAILS ON SUCCESS ---
      try {
        const orderDoc = await orderRef.get();
        if (orderDoc.exists) {
            const orderData = orderDoc.data();
            const userEmail = orderData.shippingDetails.email;

            if (userEmail) {
                // Send confirmation email to the user
                await sgMail.send({
                    to: userEmail,
                    from: SENDER_EMAIL,
                    subject: `Order Confirmed: #${orderData.merchantOrderId}`,
                    html: createOrderConfirmationHtml(orderData),
                });
                console.log(`Confirmation email sent to ${userEmail}`);

                // Send notification email to the admin
                if (ADMIN_EMAIL) {
                    await sgMail.send({
                        to: ADMIN_EMAIL,
                        from: SENDER_EMAIL,
                        subject: `🔔 New Order Received: #${orderData.merchantOrderId}`,
                        html: createAdminNotificationHtml(orderData),
                    });
                    console.log(`Admin notification sent to ${ADMIN_EMAIL}`);
                }
            }
        }
      } catch (emailError) {
          console.error("Error sending emails:", emailError.response?.body || emailError.message);
      }
    } else {
      await orderRef.update({ status: "FAILED", paymentState: decodedResponse.code });
    }

    res.status(200).send();
  } catch (error) {
    console.error("Error in /api/callback:", error);
    res.status(500).send({ success: false, message: "Error processing callback." });
  }
});

/**
 * @route   GET /api/payment/status/:merchantOrderId
 * @desc    Check payment status from the frontend
 */
app.get("/api/payment/status/:merchantOrderId", async (req, res) => {
  const { merchantOrderId } = req.params;
  try {
    const statusResponse = await phonepeClient.getOrderStatus(merchantOrderId);
    if (statusResponse && statusResponse.state) {
      const paymentState = statusResponse.state;
      const orderRef = db.collection("orders").doc(merchantOrderId);
      await orderRef.update({
        status: paymentState,
        paymentState: paymentState,
        phonepeTransactionId: statusResponse.paymentDetails?.[0]?.transactionId || null,
      });
      const updatedOrderData = (await orderRef.get()).data();
      return res.json({ success: true, status: paymentState, order: updatedOrderData });
    } else {
      return res.status(500).json({ success: false, message: "Failed to retrieve payment status." });
    }
  } catch (error) {
    console.error("Final status check error:", error.message);
    return res.status(500).json({ success: false, message: "Error during final status check." });
  }
});

/**
 * @route   GET /api/orders/:userId
 * @desc    Get all orders for a specific user
 */
app.get("/api/orders/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const orders = [];
    const snapshot = await db
      .collection("orders")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      return res.json({ success: true, orders: [] });
    }

    snapshot.forEach((doc) => {
      orders.push({ id: doc.id, ...doc.data() });
    });

    res.json({ success: true, orders });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ success: false, message: "Error fetching orders." });
  }
});

app.post("/api/login-session", async (req, res) => {
    const { uid } = req.body; // You must get the user's UID after they log in
    if (!uid) return res.status(400).json({ success: false, message: "User ID is required." });

    const ip = req.ip;
    const ua = uaParser(req.headers['user-agent']);
    const sessionId = randomUUID();

    const sessionData = {
        ipAddress: ip,
        deviceType: ua.device.type || 'desktop',
        browser: `${ua.browser.name} ${ua.browser.version}`,
        os: `${ua.os.name} ${ua.os.version}`,
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('users').doc(uid).collection('sessions').doc(sessionId).set(sessionData);
    res.json({ success: true, sessionId });
});

// POST to log out from ALL devices
app.post('/api/sessions/logout-all', async (req, res) => {
    // ✅ It now accepts a currentSessionId to know which session to KEEP
    const { userId, currentSessionId } = req.body;
    if (!userId || !currentSessionId) {
        return res.status(400).json({ success: false, message: "User ID and Current Session ID are required." });
    }

    // 1. Revoke all tokens to force re-login on other devices
    await admin.auth().revokeRefreshTokens(userId);

    // 2. Delete all session documents EXCEPT the current one
    const snapshot = await db.collection('users').doc(userId).collection('sessions').get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
        if (doc.id !== currentSessionId) { // ✅ The crucial check
            batch.delete(doc.ref);
        }
    });
    await batch.commit();

    res.json({ success: true, message: "Logged out from all other devices." });
});

// POST to log out a specific device
app.post('/api/sessions/logout-specific', async (req, res) => {
    const { userId, sessionId } = req.body;
    await db.collection('users').doc(userId).collection('sessions').doc(sessionId).delete();
    res.json({ success: true, message: "Session removed." });
});

app.listen(PORT, () => {
  console.log(
    `Server is listening on port ${PORT} in ${process.env.NODE_ENV || "development"} mode.`
  );
});