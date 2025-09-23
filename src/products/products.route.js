// ====================== src/products/products.route.js (كامل) ======================
const express = require("express");
const Products = require("./products.model");
const Reviews = require("../reviews/reviews.model");
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const router = express.Router();

const { uploadImages, uploadBufferToCloudinary } = require("../utils/uploadImage");

// (اختياري) رفع Base64 عبر هذا الراوت داخل منتجات
router.post("/uploadImages", async (req, res) => {
  try {
    const { images } = req.body; // مصفوفة Base64/DataURL
    if (!images || !Array.isArray(images)) {
      return res.status(400).send({ message: "يجب إرسال مصفوفة من الصور" });
    }
    const uploadedUrls = await uploadImages(images);
    res.status(200).send(uploadedUrls);
  } catch (error) {
    console.error("Error uploading images:", error);
    res.status(500).send({ message: "حدث خطأ أثناء تحميل الصور" });
  }
});

// إنشاء منتج
// routes/products.route.js
router.post("/create-product", async (req, res) => {
  try {
    const {
      name,
      mainCategory,
      category,        // اختياري
      description,
      oldPrice,
      price,
      image,
      author,
      size,
      inStock
    } = req.body;

    // ✅ الحقول الأساسية فقط (بدون category)
    if (!name || !mainCategory || !description || price == null || !author) {
      return res.status(400).send({ message: "الاسم، التصنيف الرئيسي، الوصف، السعر، والكاتب مطلوبة" });
    }

    // ✅ الصور: يجب أن تكون مصفوفة وفيها عنصر واحد على الأقل
    if (!Array.isArray(image) || image.length === 0) {
      return res.status(400).send({ message: "يجب إرفاق صورة واحدة على الأقل" });
    }

    // تحقق خاص لفئة معينة (إن رغبت)
    if (category === "حناء بودر" && !size) {
      return res.status(400).send({ message: "يجب تحديد حجم الحناء" });
    }

    const productData = {
      name: String(name).trim(),
      mainCategory: String(mainCategory).trim(),
      // اجعل التصنيف الفرعي اختياريًا
      category: category ? String(category).trim() : "",
      description: String(description).trim(),
      price: Number(price),
      oldPrice: oldPrice != null && oldPrice !== "" ? Number(oldPrice) : undefined,
      image: Array.isArray(image) ? image : [],
      author, // ObjectId من الواجهة
      size: size || "",
      inStock: typeof inStock === "boolean" ? inStock : true,
    };

    const newProduct = new Products(productData);
    const savedProduct = await newProduct.save();
    res.status(201).send(savedProduct);
  } catch (error) {
    console.error("Error creating new product", error);
    res.status(500).send({ message: "Failed to create new product" });
  }
});



// جميع المنتجات
router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 8, mainCategory, q } = req.query;

    const filter = {};
    if (mainCategory) filter.mainCategory = mainCategory;
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));

    const [products, totalProducts] = await Promise.all([
      Products.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      Products.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(totalProducts / limitNum) || 1;
    res.json({ products, totalPages, totalProducts });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});


// منتج واحد (يدعم مسارين)
router.get(["/:id", "/product/:id"], async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await Products.findById(productId).populate("author", "email username");
    if (!product) {
      return res.status(404).send({ message: "Product not found" });
    }
    const reviews = await Reviews.find({ productId }).populate("userId", "username email");
    res.status(200).send({ product, reviews });
  } catch (error) {
    console.error("Error fetching the product", error);
    res.status(500).send({ message: "Failed to fetch the product" });
  }
});

// تحديث منتج (إظهار/حذف صور حالية + إضافة صور جديدة)
const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.patch(
  "/update-product/:id",
  verifyToken,
  verifyAdmin,
  upload.array("image"),
  async (req, res) => {
    try {
      const productId = req.params.id;
      if (!productId || !Types.ObjectId.isValid(productId)) {
        return res.status(400).send({ message: "Invalid product id" });
      }

      const found = await Products.findById(productId);
      if (!found) {
        return res.status(404).send({ message: "المنتج غير موجود" });
      }

      const updateData = {
        name: req.body.name,
        mainCategory: req.body.mainCategory,
        category: req.body.category,
        price: req.body.price,
        oldPrice: req.body.oldPrice || null,
        description: req.body.description,
        size: req.body.size || null,
        author: req.body.author,
        inStock: String(req.body.inStock) === "true",
      };

      // تحقق من الحقول الأساسية
      if (
        !updateData.name ||
        !updateData.mainCategory ||
        !updateData.category ||
        !updateData.price ||
        !updateData.description
      ) {
        return res
          .status(400)
          .send({ message: "جميع الحقول المطلوبة يجب إرسالها" });
      }

      // مثال شرط حجم صنف معين (يمكن تعديله/إزالته)
      if (updateData.category === "حناء بودر" && !updateData.size) {
        return res.status(400).send({ message: "يجب تحديد حجم الحناء" });
      }

      // صور مُحتفظ بها من الواجهة
      let keepImages = [];
      if (typeof req.body.keepImages === "string" && req.body.keepImages.trim() !== "") {
        try {
          const parsed = JSON.parse(req.body.keepImages);
          if (Array.isArray(parsed)) keepImages = parsed;
        } catch {
          keepImages = [];
        }
      }

      // رفع صور جديدة (إن وجدت)
      let newImageUrls = [];
      if (Array.isArray(req.files) && req.files.length > 0) {
        newImageUrls = await Promise.all(
          req.files.map((file) => uploadBufferToCloudinary(file.buffer, "products"))
        );
      }

      // دمج الصور (المُبقية + الجديدة) إذا كان هناك تغيير
      if (keepImages.length > 0 || newImageUrls.length > 0) {
        updateData.image = [...keepImages, ...newImageUrls];
      } else {
        // لا تغيّر الصور إن ما وصل شيء
        delete updateData.image;
      }

      // تحويل السعر لأرقام صحيحة
      updateData.price = Number(updateData.price);
      if (updateData.oldPrice !== null && updateData.oldPrice !== "") {
        updateData.oldPrice = Number(updateData.oldPrice);
      } else {
        updateData.oldPrice = undefined;
      }

      const updated = await Products.findByIdAndUpdate(
        productId,
        { $set: updateData },
        { new: true, runValidators: true }
      );

      res.status(200).send({ message: "تم تحديث المنتج بنجاح", product: updated });
    } catch (error) {
      console.error("خطأ في تحديث المنتج", error);
      res.status(500).send({
        message: "فشل تحديث المنتج",
        error: error.message,
      });
    }
  }
);

// حذف منتج
router.delete("/:id", async (req, res) => {
  try {
    const productId = req.params.id;
    const deletedProduct = await Products.findByIdAndDelete(productId);

    if (!deletedProduct) {
      return res.status(404).send({ message: "Product not found" });
    }

    await Reviews.deleteMany({ productId });
    res.status(200).send({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting the product", error);
    res.status(500).send({ message: "Failed to delete the product" });
  }
});

// منتجات ذات صلة
router.get("/related/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).send({ message: "Product ID is required" });

    const product = await Products.findById(id);
    if (!product) return res.status(404).send({ message: "Product not found" });

    const titleRegex = new RegExp(
      product.name.split(" ").filter((w) => w.length > 1).join("|"),
      "i"
    );

    const relatedProducts = await Products.find({
      _id: { $ne: id },
      $or: [{ name: { $regex: titleRegex } }, { category: product.category }],
    });

    res.status(200).send(relatedProducts);
  } catch (error) {
    console.error("Error fetching the related products", error);
    res.status(500).send({ message: "Failed to fetch related products" });
  }
});

module.exports = router;
