// models/product.model.js
const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name:         { type: String, required: true, trim: true },
    mainCategory: { type: String, required: true, trim: true, index: true },
    category:     { type: String, required: false, trim: true, default: "" },
    description:  { type: String, required: true, trim: true },
    price:        { type: Number, required: true, min: 0 },
    image:        { type: [String], required: true },
    oldPrice:     { type: Number, min: 0 },
    rating:       { type: Number, default: 0, min: 0, max: 5 },
    author:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    inStock:      { type: Boolean, default: true },
    size:         { type: String, default: "" },
  },
  { timestamps: true }
);

ProductSchema.index({ mainCategory: 1 });
ProductSchema.index({ mainCategory: 1, category: 1 });

module.exports = mongoose.model("Product", ProductSchema);
