import { resolvePrice, UnknownUserError } from "../lib/pricing.js";

/**
 * Price preview: pick a customer and a quantity, see what they would pay and
 * why.
 *
 * This exists because the ladder's customer and category layers cannot be
 * validated against history — they have never competed in a real order. Showing
 * the resolved price *and* every losing candidate is how someone who knows the
 * business can check the rules are right.
 */
export async function previewPrice(req, res, next) {
  try {
    const { product_id, user_id, quantity } = req.query;

    if (!product_id) return res.status(400).json({ message: "product_id is required" });

    const result = await resolvePrice({
      productId: Number(product_id),
      // Omitted user_id means anonymous/base pricing, which is a valid question.
      userId: user_id ? Number(user_id) : undefined,
      quantity: quantity ? Number(quantity) : 1,
    });

    if (!result) return res.status(404).json({ message: "Product not found" });
    res.json(result);
  } catch (err) {
    if (err instanceof UnknownUserError) {
      return res.status(400).json({ message: err.message });
    }
    next(err);
  }
}
