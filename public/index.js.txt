/**
 * google-calendar-sync (Saltcorn plugin)
 *
 * Features:
 * - OAuth2 linking per user
 * - Create events from Bookings table
 * - Auto Google Meet link if GCAL_GENERATE_MEET_IF_EMPTY=true
 * - Stores config in Saltcorn (configuration_workflow)
 *
 * Tables expected:
 * - Users: google_refresh_token, calendar_id
 * - Bookings: id, host_user_id, guest_name, guest_email, guest_email2,
 *             guest_email3, guest_email4, start_time, end_time,
 *             status, google_event_id, meeting_link
 */

const { Router } = require("express");
const { google } = require("googleapis");
const db = require("@saltcorn/data/db");
const { getState } = require("@saltcorn/data/db/state");

const PLUGIN_NAME = "google-calendar-sync";
const BASE_URL = "https://business-system.app"; // change if different

// --- Helpers ---------------------------------------------------------------

function getPluginConfig() {
  const state = getState();
  return state.getConfig(PLUGIN_NAME);
}

function getOAuthClient() {
  const pluginConfig = getPluginConfig();
  if (!pluginConfig.GOOGLE_CLIENT_ID || !pluginConfig.GOOGLE_CLIENT_SECRET) {
    throw new Error("Missing plugin configuration for Google OAuth2");
  }
  return new google.auth.OAuth2(
    pluginConfig.GOOGLE_CLIENT_ID,
    pluginConfig.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/plugin/${PLUGIN_NAME}/oauth2/callback`
  );
}

function boolConfig(name, def = true) {
  const pluginConfig = getPluginConfig();
  const val = pluginConfig[name];
  if (val === undefined || val === null) return def;
  return val === true || val === "true" || val === 1;
}

function pickAttendees(booking) {
  return [
    booking.guest_email,
    booking.guest_email2,
    booking.guest_email3,
    booking.guest_email4,
  ]
    .filter(Boolean)
    .map((email) => ({ email }));
}

async function loadUserById(id) {
  const { rows } = await db.query("SELECT * FROM users WHERE id=$1", [id]);
  return rows && rows[0];
}

async function loadBookingById(id) {
  const { rows } = await db.query('SELECT * FROM "Bookings" WHERE id=$1', [
    id,
  ]);
  return rows && rows[0];
}

async function updateBookingEvent(id, eventId, meetLink) {
  await db.query(
    'UPDATE "Bookings" SET google_event_id=$1, meeting_link=$2 WHERE id=$3',
    [eventId, meetLink || "", id]
  );
}

async function saveUserTokens(userId, refreshToken, calendarId = "primary") {
  await db.query(
    "UPDATE users SET google_refresh_token=$1, calendar_id=$2 WHERE id=$3",
    [refreshToken, calendarId || "primary", userId]
  );
}

async function createGoogleEvent(user, booking) {
  if (!user || !user.google_refresh_token) {
    throw new Error("Host user is not linked to Google Calendar.");
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: user.google_refresh_token });
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const attendees = pickAttendees(booking);
  const generateMeet = boolConfig("GCAL_GENERATE_MEET_IF_EMPTY", true);

  const wantMeetLink = generateMeet && !booking.meeting_link;

  const eventResource = {
    summary: booking.guest_name
      ? `Meeting with ${booking.guest_name}`
      : "Scheduled Meeting",
    description: "Scheduled via Saltcorn Booking System",
    start: { dateTime: booking.start_time, timeZone: "UTC" },
    end: { dateTime: booking.end_time, timeZone: "UTC" },
    attendees,
  };

  if (wantMeetLink) {
    eventResource.conferenceData = {
      createRequest: {
        requestId: `saltcorn-${Date.now()}-${booking.id}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const calId = user.calendar_id || "primary";

  const insertRes = await calendar.events.insert({
    calendarId: calId,
    resource: eventResource,
    conferenceDataVersion: wantMeetLink ? 1 : 0,
    sendUpdates: "all",
  });

  const event = insertRes.data;
  const meetLink =
    (event.conferenceData &&
      event.conferenceData.entryPoints?.find(
        (p) => p.entryPointType === "video"
      )?.uri) ||
    event.hangoutLink ||
    "";

  await updateBookingEvent(booking.id, event.id, meetLink);
  return event;
}

// --- Plugin export ---------------------------------------------------------

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: PLUGIN_NAME,

  configuration_workflow: async () => [
    {
      name: "GOOGLE_CLIENT_ID",
      label: "Google OAuth Client ID",
      type: "String",
      required: true,
    },
    {
      name: "GOOGLE_CLIENT_SECRET",
      label: "Google OAuth Client Secret",
      type: "String",
      required: true,
    },
    {
      name: "GOOGLE_SYNC_SECRET",
      label: "Webhook secret for booking sync",
      type: "String",
      required: true,
      default: () => Math.random().toString(36).substring(2, 15),
    },
    {
      name: "GCAL_GENERATE_MEET_IF_EMPTY",
      label: "Automatically generate Google Meet if meeting_link is empty?",
      type: "Bool",
      required: true,
      default: true,
    },
  ],

  routes: () => {
    const router = new Router();

    router.get("/oauth2/init", async (req, res) => {
      try {
        if (!req.user?.id)
          return res.status(401).send("Please log in to link Google Calendar.");

        const client = getOAuthClient();
        const url = client.generateAuthUrl({
          access_type: "offline",
          scope: ["https://www.googleapis.com/auth/calendar"],
          prompt: "consent",
          state: String(req.user.id),
        });
        return res.redirect(url);
      } catch (e) {
        console.error("[google-calendar-sync] /oauth2/init error:", e);
        return res.status(500).send("OAuth init failed.");
      }
    });

    router.get("/oauth2/callback", async (req, res) => {
      try {
        const { code, state } = req.query;
        if (!code) return res.status(400).send("Missing code");
        const userId = parseInt(state, 10);
        if (!userId) return res.status(400).send("Invalid state");

        const client = getOAuthClient();
        const { tokens } = await client.getToken(code);

        if (!tokens.refresh_token) {
          return res.status(400).send(
            "No refresh token returned. Remove app from Google permissions and retry."
          );
        }

        await saveUserTokens(userId, tokens.refresh_token, "primary");
        return res.send("✅ Google Calendar linked successfully.");
      } catch (e) {
        console.error("[google-calendar-sync] /oauth2/callback error:", e);
        return res.status(500).send("OAuth callback failed.");
      }
    });

    router.post("/bookings/push", async (req, res) => {
      try {
        const pluginConfig = getPluginConfig();
        const secret = req.get("X-Webhook-Secret");
        if (!secret || secret !== pluginConfig.GOOGLE_SYNC_SECRET)
          return res.status(401).send("Unauthorized");

        const { booking_id } = req.body || {};
        if (!booking_id) return res.status(400).send("Missing booking_id");

        const booking = await loadBookingById(booking_id);
        if (!booking) return res.status(404).send("Booking not found");

        const user = await loadUserById(booking.host_user_id);
        if (!user) return res.status(404).send("Host user not found");

        const event = await createGoogleEvent(user, booking);
        return res.json({ ok: true, eventId: event.id });
      } catch (e) {
        console.error("[google-calendar-sync] /bookings/push error:", e);
        return res.status(500).send("Push failed");
      }
    });

    // Admin-only manual push
    router.get("/bookings/push/:id", async (req, res) => {
      try {
        const state = getState();
        const isAdmin =
          req.user &&
          state.roles_by_id?.[req.user.role_id]?.role === "admin";
        if (!isAdmin) return res.status(403).send("Admins only");

        const bookingId = parseInt(req.params.id, 10);
        const booking = await loadBookingById(bookingId);
        if (!booking) return res.status(404).send("Booking not found");

        const user = await loadUserById(booking.host_user_id);
        if (!user) return res.status(404).send("Host user not found");

        const event = await createGoogleEvent(user, booking);
        return res.send(`Pushed. Event ID: ${event.id}`);
      } catch (e) {
        console.error("[google-calendar-sync] manual push error:", e);
        return res.status(500).send("Manual push failed");
      }
    });

    return router;
  },
};
