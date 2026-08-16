const PDFDocument = require("pdfkit");

function buildItineraryPdf(trip, itinerary) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc
      .fontSize(24)
      .fillColor("#1a1a1a")
      .text(itinerary.destination || trip.destination, { align: "center" });

    doc.moveDown(0.3);
    doc
      .fontSize(11)
      .fillColor("#555")
      .text(
        [trip.name && `Prepared for ${trip.name}`, trip.startDate && trip.endDate && `${trip.startDate} - ${trip.endDate}`]
          .filter(Boolean)
          .join("  |  "),
        { align: "center" }
      );

    doc.moveDown(1);

    if (itinerary.summary) {
      doc.fontSize(12).fillColor("#333").text(itinerary.summary, { align: "left" });
      doc.moveDown(1);
    }

    (itinerary.days || []).forEach((day, idx) => {
      if (idx > 0) doc.moveDown(0.8);
      doc
        .fontSize(15)
        .fillColor("#0b5")
        .text(`${day.date || `Day ${idx + 1}`}${day.title ? " — " + day.title : ""}`);
      doc.moveDown(0.3);

      (day.activities || []).forEach((activity) => {
        doc
          .fontSize(11)
          .fillColor("#111")
          .text(`${activity.time ? activity.time + ": " : ""}${activity.description}`, {
            indent: 15,
            lineGap: 3,
          });
      });
    });

    if (itinerary.tips && itinerary.tips.length) {
      doc.moveDown(1);
      doc.fontSize(14).fillColor("#0b5").text("Travel Tips");
      doc.moveDown(0.3);
      itinerary.tips.forEach((tip) => {
        doc.fontSize(11).fillColor("#111").text(`• ${tip}`, { indent: 15, lineGap: 3 });
      });
    }

    doc.end();
  });
}

module.exports = { buildItineraryPdf };
