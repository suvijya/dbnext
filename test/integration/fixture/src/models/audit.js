const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    actorId: { type: Number },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AuditEvent', auditSchema);
