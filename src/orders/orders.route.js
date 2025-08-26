const express = require("express");
const cors = require("cors");
const Order = require("./orders.model");
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const router = express.Router();
const axios = require("axios");
require("dotenv").config();
// import axios from 'axios';
// import Order from '../models/Order.js';            // تأكد من المسار
// import { sendOrderWhatsApp, notifyAdmin } from '../utils/whatsapp.js';

const THAWANI_API_KEY = process.env.THAWANI_API_KEY; 
const THAWANI_API_URL = process.env.THAWANI_API_URL;
const publish_key = "HGvTMLDssJghr9tlN9gr4DVYt0qyBy";

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// Create checkout session
// ========================= routes/orders.js (create-checkout-session) =========================
// ===== Helpers =====
const toBaisa = (omr) => Math.max(100, Math.round(Number(omr || 0) * 1000)); // >= 100 بيسة

// خصم الأزواج للشيلات (ر.ع.)
const pairDiscountForProduct = (p) => {
  const isShayla =
    p.category === "الشيلات فرنسية" || p.category === "الشيلات سادة";
  if (!isShayla) return 0;
  const qty = Number(p.quantity || 0);
  const pairs = Math.floor(qty / 2);
  return pairs * 1; // 1 ر.ع لكل زوج
};

// ===== Route =====
// ========================= routes/orders.js (create-checkout-session) =========================
router.post("/create-checkout-session", async (req, res) => {
  const {
    products,
    email,
    customerName,
    customerPhone,
    country,
    wilayat,
    description,
    depositMode, // إذا true: المقدم 10 ر.ع (من ضمنه التوصيل)
    giftCard,    // { from, to, phone, note } اختياري
  } = req.body;

  const shippingFee = country === "الإمارات" ? 4 : 2; // (ر.ع.)
  const DEPOSIT_AMOUNT_OMR = 10; // المقدم الثابت

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Invalid or empty products array" });
  }

  // تحويل ريال عماني إلى بيسة مع حد أدنى 100 بيسة
  const toBaisa = (amountOMR) => Math.max(100, Math.round(Number(amountOMR || 0) * 1000));

  // خصم الأزواج للشيلات (ر.ع.)
  const pairDiscountForProduct = (p) => {
    const isShayla = p.category === "الشيلات فرنسية" || p.category === "الشيلات سادة";
    if (!isShayla) return 0;
    const qty = Number(p.quantity || 0);
    const pairs = Math.floor(qty / 2);
    return pairs * 1; // 1 ر.ع لكل زوج
  };

  try {
    // مجاميع أصلية (لحساب السعر الكامل والمتبقي)
    const productsSubtotal = products.reduce(
      (sum, p) => sum + Number(p.price || 0) * Number(p.quantity || 0),
      0
    );
    const totalPairDiscount = products.reduce(
      (sum, p) => sum + pairDiscountForProduct(p),
      0
    );
    const subtotalAfterDiscount = Math.max(0, productsSubtotal - totalPairDiscount);
    const originalTotal = subtotalAfterDiscount + shippingFee; // السعر الأصلي (منتجات بعد الخصم + شحن)

    let lineItems = [];
    let amountToCharge = 0;

    if (depositMode) {
      // دفعة مقدم 10 ر.ع (من ضمنه التوصيل)
      lineItems = [
        {
          name: "دفعة مقدم",
          quantity: 1,
          unit_amount: toBaisa(DEPOSIT_AMOUNT_OMR),
        },
      ];
      amountToCharge = DEPOSIT_AMOUNT_OMR;
    } else {
      // توزيع خصم الشيلات داخل سعر الوحدة لكل منتج
      lineItems = products.map((p) => {
        const unitBase = Number(p.price || 0);
        const qty = Math.max(1, Number(p.quantity || 1));
        const productDiscount = pairDiscountForProduct(p);
        const unitAfterDiscount = Math.max(0.1, unitBase - productDiscount / qty); // لا يقل عن 0.100
        return {
          name: String(p.name || "منتج"),
          quantity: qty,
          unit_amount: toBaisa(unitAfterDiscount),
        };
      });

      // بند الشحن كبند مستقل
      lineItems.push({
        name: "رسوم الشحن",
        quantity: 1,
        unit_amount: toBaisa(shippingFee),
      });

      amountToCharge = originalTotal;
    }

    const nowId = Date.now().toString();

    const data = {
      client_reference_id: nowId,
      mode: "payment",
      products: lineItems,
      success_url: "http://localhost:5173/SuccessRedirect?client_reference_id=" + nowId,
      cancel_url: "http://localhost:5173/cancel",
      metadata: {
        email: String(email || "غير محدد"),
        customer_name: String(customerName || ""),
        customer_phone: String(customerPhone || ""),
        country: String(country || ""),
        wilayat: String(wilayat || ""),
        description: String(description || "لا يوجد وصف"),
        shippingFee: String(shippingFee),
        internal_order_id: String(nowId),
        source: "mern-backend",
        pair_discount_total_omr: String(totalPairDiscount),
      },
    };

    const response = await axios.post(`${THAWANI_API_URL}/checkout/session`, data, {
      headers: {
        "Content-Type": "application/json",
        "thawani-api-key": THAWANI_API_KEY,
      },
    });

    const sessionId = response?.data?.data?.session_id;
    if (!sessionId) {
      return res.status(500).json({
        error: "No session_id returned from Thawani",
        details: response?.data,
      });
    }

    const paymentLink = `https://uatcheckout.thawani.om/pay/${sessionId}?key=${publish_key}`;

    // حساب المتبقي: (السعر الأصلي) - 10
    const remainingAmount = depositMode ? Math.max(0, originalTotal - DEPOSIT_AMOUNT_OMR) : 0;

    // إنشاء الطلب + حفظ بيانات بطاقة الهدية (إن وُجدت)
    const order = new Order({
      orderId: nowId,
      products: products.map((p) => ({
        productId: p._id,
        quantity: p.quantity,
        name: p.name,
        price: p.price, // ر.ع.
        image: Array.isArray(p.image) ? p.image[0] : p.image,
        measurements: p.measurements || {},
        category: p.category || "",
      })),
      amount: amountToCharge,    // المدفوع الآن
      shippingFee: shippingFee,  // محفوظ دائماً للحسابات
      customerName,
      customerPhone,
      country,
      wilayat,
      description,
      email: email || "",
      status: "pending",
      depositMode: !!depositMode,
      remainingAmount,

      giftCard: giftCard
        ? {
            from: giftCard.from || "",
            to: giftCard.to || "",
            phone: giftCard.phone || "",
            note: giftCard.note || "",
          }
        : undefined, // لو ما أرسل، لا نكتب الحقل (وسيأخذ Default من الموديل عند الحاجة)
    });

    await order.save();

    res.json({ id: sessionId, paymentLink });
  } catch (error) {
    console.error("Error creating checkout session:", error?.response?.data || error);
    res.status(500).json({
      error: "Failed to create checkout session",
      details: error?.response?.data || error.message,
    });
  }
});


// في ملف routes/orders.js
router.get('/order-with-products/:orderId', async (req, res) => {
    try {
        const order = await Order.findById(req.params.orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const products = await Promise.all(order.products.map(async item => {
            const product = await Product.findById(item.productId);
            return {
                ...product.toObject(),
                quantity: item.quantity,
                selectedSize: item.selectedSize,
                price: calculateProductPrice(product, item.quantity, item.selectedSize)
            };
        }));

        res.json({ order, products });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function calculateProductPrice(product, quantity, selectedSize) {
    if (product.category === 'حناء بودر' && selectedSize && product.price[selectedSize]) {
        return (product.price[selectedSize] * quantity).toFixed(2);
    }
    return (product.regularPrice * quantity).toFixed(2);
}
// Confirm payment
// ========================= routes/orders.js (confirm-payment) =========================
// ========================= routes/orders.js (confirm-payment النهائي) =========================
router.post("/confirm-payment", async (req, res) => {
  const { client_reference_id } = req.body;

  if (!client_reference_id) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  try {
    // 1) جلب قائمة الجلسات ثم إيجاد الجلسة بالـ client_reference_id
    const sessionsResponse = await axios.get(
      `${THAWANI_API_URL}/checkout/session/?limit=20&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const sessions = sessionsResponse?.data?.data || [];
    const sessionSummary = sessions.find(
      (s) => s.client_reference_id === client_reference_id
    );

    if (!sessionSummary) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session_id = sessionSummary.session_id;

    // 2) تفاصيل الجلسة
    const response = await axios.get(
      `${THAWANI_API_URL}/checkout/session/${session_id}?limit=1&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const session = response?.data?.data;
    if (!session || session.payment_status !== "paid") {
      return res
        .status(400)
        .json({ error: "Payment not successful or session not found" });
    }

    // 3) قراءة الميتاداتا (نفس ما أرسلناه في الإنشاء)
    const meta = session?.metadata || session?.meta_data || {};
    const metaCustomerName = meta.customer_name || "";
    const metaCustomerPhone = meta.customer_phone || "";
    const metaEmail = meta.email || "";
    const metaCountry = meta.country || "";
    const metaWilayat = meta.wilayat || "";
    const metaDescription = meta.description || "";
    const metaShippingFee =
      typeof meta.shippingFee !== "undefined" ? Number(meta.shippingFee) : undefined;

    // 4) تحديث الطلب (نبحث باستخدام client_reference_id أولاً)
    let order = await Order.findOne({ orderId: client_reference_id });

    // احتياط: إن لم نجده (حالات نادرة جداً)
    if (!order) {
      order = await Order.findOne({ orderId: session_id });
    }

    // المبلغ المدفوع فعلياً من ثواني (بالريال العُماني)
    const paidAmountOMR = Number(session.total_amount || 0) / 1000;

    if (!order) {
      // إنشاء طلب احتياطي بالحد الأدنى من البيانات (في حال لم يُحفظ قبل إنشاء الجلسة)
      order = new Order({
        orderId: client_reference_id,
        products: [], // لا تتوفر بنية المنتجات كاملة من ثواني هنا
        amount: paidAmountOMR,
        shippingFee:
          typeof metaShippingFee !== "undefined" ? metaShippingFee : 2,
        customerName: metaCustomerName,
        customerPhone: metaCustomerPhone,
        country: metaCountry,
        wilayat: metaWilayat,
        description: metaDescription,
        email: metaEmail,
        status: "completed",
        // ملاحظة: لا نضع/نغيّر depositMode أو remainingAmount هنا لعدم معرفتنا بهما
      });
    } else {
      // تحديث الحقول الأساسية فقط
      order.status = "completed";
      order.amount = paidAmountOMR; // ما تم دفعه فعلياً لدى ثواني

      // تعبئة أي معلومات ناقصة من الميتاداتا
      if (!order.customerName && metaCustomerName) order.customerName = metaCustomerName;
      if (!order.customerPhone && metaCustomerPhone) order.customerPhone = metaCustomerPhone;
      if (!order.country && metaCountry) order.country = metaCountry;
      if (!order.wilayat && metaWilayat) order.wilayat = metaWilayat;
      if (!order.description && metaDescription) order.description = metaDescription;
      if (!order.email && metaEmail) order.email = metaEmail;

      // لا نغيّر depositMode أو remainingAmount المحفوظين مسبقًا
      if (
        (order.shippingFee === undefined || order.shippingFee === null) &&
        typeof metaShippingFee !== "undefined"
      ) {
        order.shippingFee = metaShippingFee;
      }
    }

    // تخزين session_id ووقت الدفع
    order.paymentSessionId = session_id;
    order.paidAt = new Date();

    await order.save();

    res.json({ order });
  } catch (error) {
    console.error("Error confirming payment:", error?.response?.data || error);
    res.status(500).json({
      error: "Failed to confirm payment",
      details: error?.response?.data || error.message,
    });
  }
});
// Get order by email
router.get("/:email", async (req, res) => {
    const email = req.params.email;

    if (!email) {
        return res.status(400).send({ message: "Email is required" });
    }

    try {
        const orders = await Order.find({ email: email });

        if (orders.length === 0) {
            return res.status(404).send({ message: "No orders found for this email" });
        }

        res.status(200).send({ orders });
    } catch (error) {
        console.error("Error fetching orders by email:", error);
        res.status(500).send({ message: "Failed to fetch orders by email" });
    }
});

// get order by id
router.get("/order/:id", async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).send(order);
    } catch (error) {
        console.error("Error fetching orders by user id", error);
        res.status(500).send({ message: "Failed to fetch orders by user id" });
    }
});

// get all orders
router.get("/", async (req, res) => {
    try {
        const orders = await Order.find({status:"completed"}).sort({ createdAt: -1 });
        if (orders.length === 0) {
            return res.status(404).send({ message: "No orders found", orders: [] });
        }

        res.status(200).send(orders);
    } catch (error) {
        console.error("Error fetching all orders", error);
        res.status(500).send({ message: "Failed to fetch all orders" });
    }
});

// update order status
router.patch("/update-order-status/:id", async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) {
        return res.status(400).send({ message: "Status is required" });
    }

    try {
        const updatedOrder = await Order.findByIdAndUpdate(
            id,
            {
                status,
                updatedAt: new Date(),
            },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!updatedOrder) {
            return res.status(404).send({ message: "Order not found" });
        }

        res.status(200).json({
            message: "Order status updated successfully",
            order: updatedOrder
        });

    } catch (error) {
        console.error("Error updating order status", error);
        res.status(500).send({ message: "Failed to update order status" });
    }
});

// delete order
router.delete('/delete-order/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const deletedOrder = await Order.findByIdAndDelete(id);
        if (!deletedOrder) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).json({
            message: "Order deleted successfully",
            order: deletedOrder
        });

    } catch (error) {
        console.error("Error deleting order", error);
        res.status(500).send({ message: "Failed to delete order" });
    }
});

module.exports = router;