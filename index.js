const { google } = require("googleapis");
const User = require("@saltcorn/data/models/user");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const db = require("@saltcorn/data/db");
const { getState } = require("@saltcorn/data/db/state");

const PLUGIN_NAME = "google-booking";

// Ensure base URL ends with slash
const ensure_final_slash = (s) => (s.endsWith("/") ? s : s + "/");

// ================= GOOGLE AUTHENTICATION PER USER =================

const authentication = (config) => {
  const cfg_base_url = getState().getConfig("base_url");
  const callbackURL = `${ensure_final_slash(cfg_base_url)}auth/google-calendar/callback`;

  return {
    google_calendar: {
      icon: '<i class="fab fa-google"></i>',
      label: "Google Calendar",
      parameters: { scope: ["profile", "email", "https://www.googleapis.com/auth/calendar.events"] },
      strategy: new (require("passport-google-oauth20").Strategy)(
        {
          clientID: config.clientID || "nokey",
          clientSecret: config.clientSecret || "nosecret",
          callbackURL,
        },
        async function (accessToken, refreshToken, profile, cb) {
          try {
            let email = profile._json?.email || profile.emails?.[0]?.value || "";
            // Find or create user by Google ID
            const user = await User.findOrCreateByAttribute("googleId", profile.id, { email });
            // Save refresh token for calendar use
            await user.update({ google_refresh_token: refreshToken, calendar_id: "primary" });
            return cb(null, user.session_object);
          } catch (err) {
            console.error("Google Calendar Auth error:", err);
            return cb(null, false);
          }
        }
      ),
    },
  };
};

// ================= CONFIGURATION WORKFLOW =================

const configuration_workflow = () => {
  const cfg_base_url = getState().getConfig("base_url");
  const blurb = [
    !cfg_base_url ? "You should set the 'Base URL' configuration property. " : "",
    `Create a new Google OAuth application at <a href="https://console.developers.google.com/apis/credentials">Google Developer Console</a>.
Set the Authorised redirect URI to ${ensure_final_slash(cfg_base_url)}auth/google-calendar/callback. HTTPS should be enabled.`,
  ];

  return new Workflow({
    steps: [
      {
        name: "API keys",
        form: () =>
          new Form({
            labelCols: 3,
            blurb,
            fields: [
              {
                name: "clientID",
                label: "Google Client ID",
                type: "String",
                required: true,
              },
              {
                name: "clientSecret",
                label: "Google Client Secret",
                type: "String",
                required: true,
              },
              {
                name: "default_meeting_platform",
                label: "Default Meeting Platform",
                type: "String",
                required: true,
                default: "Google Meet",
              },
            ],
          }),
      },
    ],
  });
};

// ================= HELPER FUNCTIONS =================

// Function to generate OAuth2 client for a user
const getOAuthClientForUser = (config, user) => {
  const base_url = getState().getConfig("base_url");
  return new google.auth.OAuth2(
    config.clientID,
    config.clientSecret,
    `${ensure_final_slash(base_url)}auth/google-calendar/callback`
  ).setCredentials({ refresh_token: user.google_refresh_token });
};

// ================= PLUGIN EXPORT =================

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: PLUGIN_NAME,
  authentication,
  configuration_workflow,
  after_install: async ({ configuration }) => {
    // Create Bookings table if not exists
    const tableExists = await db.tableExists("Bookings");
    if (!tableExists) {
      await db.query(`
        CREATE TABLE "Bookings" (
          id SERIAL PRIMARY KEY,
          host_user_id INTEGER REFERENCES users(id),
          guest_name TEXT,
          guest_email TEXT,
          guest_email2 TEXT,
          guest_email3 TEXT,
          guest_email4 TEXT,
          start_time TIMESTAMP,
          end_time TIMESTAMP,
          status TEXT,
          google_event_id TEXT,
          meeting_link TEXT
        )
      `);
    }

    // Ensure Users table has Google Calendar fields
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users'`);
    const colNames = cols.rows.map((r) => r.column_name);
    if (!colNames.includes("google_refresh_token")) await db.query(`ALTER TABLE users ADD COLUMN google_refresh_token TEXT`);
    if (!colNames.includes("calendar_id")) await db.query(`ALTER TABLE users ADD COLUMN calendar_id TEXT`);
    if (!colNames.includes("available_hours")) await db.query(`ALTER TABLE users ADD COLUMN available_hours JSON`);
  },
};
