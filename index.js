const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { google } = require("googleapis");

const PLUGIN_NAME = "google-booking";

const configuration_workflow = () => ({
  run: async () => [
    {
      name: "BOOKINGS_TABLE",
      label: "Bookings table name",
      type: "String",
      required: true,
      default: "Bookings"
    },
    {
      name: "USER_TABLE",
      label: "Users table name",
      type: "String",
      required: true,
      default: "users"
    },
    {
      name: "GOOGLE_CLIENT_ID",
      label: "Google OAuth Client ID",
      type: "String",
      required: true
    },
    {
      name: "GOOGLE_CLIENT_SECRET",
      label: "Google OAuth Client Secret",
      type: "String",
      required: true
    },
    {
      name: "DEFAULT_MEETING_PLATFORM",
      label: "Default Meeting Platform (Google Meet/Zoom)",
      type: "String",
      required: true,
      default: "Google Meet"
    }
  ]
});
// ====================== UTILITY FUNCTIONS ======================

async function ensureTables(pluginConfig) {
  // Create Bookings table if not exists
  const tableExists = await db.tableExists(pluginConfig.BOOKINGS_TABLE);
  if (!tableExists) {
    await db.query(`
      CREATE TABLE ${pluginConfig.BOOKINGS_TABLE} (
        id SERIAL PRIMARY KEY,
        host_user_id INTEGER REFERENCES ${pluginConfig.USER_TABLE}(id),
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

  // Ensure Users table has Google OAuth and availability fields
  const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='${pluginConfig.USER_TABLE}'`);
  const colNames = cols.rows.map(r => r.column_name);

  if (!colNames.includes("google_refresh_token")) {
    await db.query(`ALTER TABLE ${pluginConfig.USER_TABLE} ADD COLUMN google_refresh_token TEXT`);
  }
  if (!colNames.includes("calendar_id")) {
    await db.query(`ALTER TABLE ${pluginConfig.USER_TABLE} ADD COLUMN calendar_id TEXT`);
  }
  if (!colNames.includes("available_hours")) {
    await db.query(`ALTER TABLE ${pluginConfig.USER_TABLE} ADD COLUMN available_hours JSON`);
  }
}

// ====================== GOOGLE OAUTH ======================

function getOAuthClient(pluginConfig, baseUrl, userId) {
  return new google.auth.OAuth2(
    pluginConfig.GOOGLE_CLIENT_ID,
    pluginConfig.GOOGLE_CLIENT_SECRET,
    `${baseUrl}/auth/google/callback?state=${userId}`
  );
}

// ====================== PLUGIN EXPORT ======================

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: PLUGIN_NAME,
  configuration_workflow,
  async after_install({ configuration }) {
    await ensureTables(configuration);
  }
};
