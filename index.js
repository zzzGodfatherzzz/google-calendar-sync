const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");

const configuration_workflow = () => {
  return new Workflow({
    steps: [
      {
        name: "Booking Settings",
        form: () =>
          new Form({
            labelCols: 3,
            blurb: "Configure booking defaults. Each user can later set their own availability.",
            fields: [
              { name: "default_duration", label: "Default Duration (minutes)", type: "Integer", required: true, default: 30 },
              { name: "buffer_time", label: "Buffer (minutes)", type: "Integer", required: true, default: 15 },
              { name: "google_api_client_id", label: "Google API Client ID", type: "String", required: true },
              { name: "google_api_client_secret", label: "Google API Client Secret", type: "String", required: true },
            ],
          }),
      },
    ],
  });
};

const onInstall = async () => {
  const bookings = await Table.findOne({ name: "Bookings" });
  if (!bookings) {
    await Table.create("Bookings", [
      { name: "user_id", type: "Integer", required: true },
      { name: "guest_name", type: "String", required: true },
      { name: "guest_email", type: "String", required: true },
      { name: "date", type: "Date", required: true },
      { name: "start_time", type: "Time", required: true },
      { name: "end_time", type: "Time", required: true },
      { name: "status", type: "String", attributes: { options: ["pending", "confirmed", "cancelled"] }, required: true },
      { name: "google_event_id", type: "String" },
    ]);
  }

  const availability = await Table.findOne({ name: "Availability" });
  if (!availability) {
    await Table.create("Availability", [
      { name: "user_id", type: "Integer", required: true },
      { name: "weekday", type: "Integer", required: true },
      { name: "start_time", type: "Time", required: true },
      { name: "end_time", type: "Time", required: true },
    ]);
  }
};

module.exports = {
  sc_plugin_api_version: 1,
  configuration_workflow,
  onInstall,
  description: "Calendly-style booking with Google Calendar integration. Users can set availability and accept bookings directly in Saltcorn.",
};
