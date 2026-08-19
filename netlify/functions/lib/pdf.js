const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

// 1TripWiser brand palette, sampled from the logo.
const BRAND = {
  navy: "#0F1525",
  gold: "#FDB415",
  teal: "#1B93B0",
  charcoal: "#333333",
  slate: "#6B7280",
  cardBg: "#F7F5EF",
  ruleLight: "#E5E1D3",
  white: "#FFFFFF",
};

// Optional: drop a logo.png next to this file to have it embedded in the
// header. Purely cosmetic — missing/unreadable logo never breaks the PDF.
const LOGO_PATH = path.join(__dirname, "logo.png");

function buildItineraryPdf(trip, itinerary) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // --- Logo ---
    try {
      if (fs.existsSync(LOGO_PATH)) {
        const logoWidth = 70;
        doc.image(LOGO_PATH, doc.page.margins.left + pageWidth / 2 - logoWidth / 2, doc.y, { width: logoWidth });
        doc.moveDown(3.2);
      }
    } catch (err) {
      // Ignore - render without the logo.
    }

    // --- Gold rule ---
    doc.rect(doc.page.margins.left, doc.y, pageWidth, 2).fill(BRAND.gold);
    doc.moveDown(1);

    // --- Title ---
    doc
      .font("Helvetica-Bold")
      .fontSize(22)
      .fillColor(BRAND.navy)
      .text((itinerary.destination || trip.destination || "").toUpperCase(), { align: "center" });

    doc.moveDown(0.3);
    doc
      .font("Helvetica-Oblique")
      .fontSize(10)
      .fillColor(BRAND.slate)
      .text(
        [
          trip.name && `Prepared for ${trip.name}`,
          [trip.travelDate, trip.duration].filter(Boolean).join(" \u00B7 "),
          trip.departingFrom && `Departing from ${trip.departingFrom}`,
        ]
          .filter(Boolean)
          .join("   |   "),
        { align: "center" }
      );

    doc.moveDown(1);

    // --- Summary card ---
    if (itinerary.summary) {
      const cardY = doc.y;
      const cardPadding = 12;
      doc.font("Helvetica").fontSize(11);
      const textHeight = doc.heightOfString(itinerary.summary, { width: pageWidth - cardPadding * 2 });
      doc.rect(doc.page.margins.left, cardY, pageWidth, textHeight + cardPadding * 2).fill(BRAND.cardBg);
      doc
        .fillColor(BRAND.charcoal)
        .text(itinerary.summary, doc.page.margins.left + cardPadding, cardY + cardPadding, {
          width: pageWidth - cardPadding * 2,
        });
      doc.y = cardY + textHeight + cardPadding * 2;
      doc.moveDown(1);
    }

    // --- Days ---
    (itinerary.days || []).forEach((day, idx) => {
      if (idx > 0) doc.moveDown(0.6);

      const bannerLabel = `${day.date || `Day ${idx + 1}`}${day.title ? "   \u00B7   " + day.title : ""}`;
      const bannerY = doc.y;
      const bannerHeight = 26;
      doc.rect(doc.page.margins.left, bannerY, pageWidth, bannerHeight).fill(BRAND.navy);
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor(BRAND.white)
        .text(bannerLabel, doc.page.margins.left + 12, bannerY + 7);
      doc.y = bannerY + bannerHeight + 8;

      (day.activities || []).forEach((activity) => {
        const timeLabel = activity.time ? activity.time.toUpperCase() : "";
        const titleText = activity.title || activity.description || "";
        doc.font("Helvetica-Bold").fontSize(11);
        if (timeLabel) {
          doc.fillColor(BRAND.gold).text(timeLabel + "  ", { continued: true });
        }
        doc.fillColor(BRAND.navy).text(titleText);

        const details = activity.details && activity.details.length ? activity.details : activity.description ? [activity.description] : [];
        details.forEach((detail) => {
          doc.font("Helvetica").fontSize(10.5).fillColor(BRAND.charcoal).text(`•  ${detail}`, { indent: 16, lineGap: 2 });
        });
        doc.moveDown(0.4);
      });
    });

    // --- Tips ---
    if (itinerary.tips && itinerary.tips.length) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(12).fillColor(BRAND.teal).text("TRAVEL TIPS");
      doc.moveDown(0.3);
      itinerary.tips.forEach((tip) => {
        doc.font("Helvetica").fontSize(10.5).fillColor(BRAND.charcoal).text(`•  ${tip}`, { indent: 16, lineGap: 2 });
      });
    }

    // --- Footer rule + line ---
    doc.moveDown(1);
    doc.rect(doc.page.margins.left, doc.y, pageWidth, 1).fill(BRAND.ruleLight);
    doc.moveDown(0.5);
    doc
      .font("Helvetica-Oblique")
      .fontSize(8.5)
      .fillColor(BRAND.slate)
      .text("Crafted with care by 1TripWiser  \u00B7  www.1tripwiser.com", { align: "center" });

    doc.end();
  });
}

module.exports = { buildItineraryPdf };
