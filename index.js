const { Router } = require("express");
const { google } = require("googleapis");
const db = require("@saltcorn/data/db");
const { getState } = require("@saltcorn/data/db/state");

const PLUGIN_NAME = "google-calendar-sync";

const configuration_workflow = async () => [
  {
    name: "BASE_URL",
    label: "Full site URL (e.g., https://business-system.app)",
    type: "String",
    required: true,
    default: () => "https://business-system.app",
  },
  {
    name: "BOOKING_TABLE",
    label: "Name of the Bookings table",
    type: "String",
    required: true,
    default: "Bookings",
  },
  {
    name: "USER_TABLE",
    label: "Name of the Users table",
    type: "String",
    required: true,
    default: "users",
  },
  {
    name: "BOOKING_FIELDS",
    label: "Comma-separated booking field mapping (id,host_user_id,guest_name,guest_email,guest_email2,guest_email3,guest_email4,start_time,end_time,status,google_event_id,meeting_link)",
    type: "String",
    required: true,
    default: "id,host_user_id,guest_name,guest_email,guest_email2,guest_email3,guest_email4,start_time,end_time,status,google_event_id,meeting_link",
  },
  {
    name: "USER_FIELDS",
    label: "Comma-separated user field mapping (refresh_token,calendar_id)",
    type: "String",
    required: true,
    default: "google_refresh_token,calendar_id",
  },
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
];

function getPluginConfig() {
  const state = getState();
  return state.getConfig(PLUGIN_NAME);
}

function getDynamicFields() {
  const pluginConfig = getPluginConfig();
  const BASE_URL = pluginConfig.BASE_URL;
  const BOOKING_TABLE = pluginConfig.BOOKING_TABLE;
  const USER_TABLE = pluginConfig.USER_TABLE;

  const bookingFieldsArray = pluginConfig.BOOKING_FIELDS.split(",");
  const BOOKING_FIELDS_KEYS = [
    "id","host_user_id","guest_name","guest_email","guest_email2","guest_email3","guest_email4",
    "start_time","end_time","status","google_event_id","meeting_link"
  ];
  const BOOKING_FIELDS = {};
  BOOKING_FIELDS_KEYS.forEach((key, i) => BOOKING_FIELDS[key] = bookingFieldsArray[i]);

  const userFieldsArray = pluginConfig.USER_FIELDS.split(",");
  const USER_FIELDS_KEYS = ["refresh_token","calendar_id"];
  const USER_FIELDS = {};
  USER_FIELDS_KEYS.forEach((key,i)=>USER_FIELDS[key]=userFieldsArray[i]);

  return { BASE_URL, BOOKING_TABLE, USER_TABLE, BOOKING_FIELDS, USER_FIELDS, pluginConfig };
}

function getOAuthClient(BASE_URL) {
  const pluginConfig = getPluginConfig();
  if (!pluginConfig.GOOGLE_CLIENT_ID || !pluginConfig.GOOGLE_CLIENT_SECRET)
    throw new Error("Missing plugin configuration for Google OAuth2");
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

function pickAttendees(booking, BOOKING_FIELDS) {
  return [
    booking[BOOKING_FIELDS.guest_email],
    booking[BOOKING_FIELDS.guest_email2],
    booking[BOOKING_FIELDS.guest_email3],
    booking[BOOKING_FIELDS.guest_email4],
  ].filter(Boolean).map(email=>({email}));
}

async function loadUserById(USER_TABLE, USER_FIELDS, id) {
  const { rows } = await db.query(`SELECT * FROM ${USER_TABLE} WHERE id=$1`, [id]);
  return rows && rows[0];
}

async function loadBookingById(BOOKING_TABLE, id) {
  const { rows } = await db.query(`SELECT * FROM ${BOOKING_TABLE} WHERE id=$1`, [id]);
  return rows && rows[0];
}

async function updateBookingEvent(BOOKING_TABLE, BOOKING_FIELDS, id, eventId, meetLink) {
  await db.query(
    `UPDATE ${BOOKING_TABLE} SET ${BOOKING_FIELDS.google_event_id}=$1, ${BOOKING_FIELDS.meeting_link}=$2 WHERE ${BOOKING_FIELDS.id}=$3`,
    [eventId, meetLink||"", id]
  );
}

async function saveUserTokens(USER_TABLE, USER_FIELDS, userId, refreshToken, calendarId="primary") {
  await db.query(
    `UPDATE ${USER_TABLE} SET ${USER_FIELDS.refresh_token}=$1, ${USER_FIELDS.calendar_id}=$2 WHERE id=$3`,
    [refreshToken, calendarId||"primary", userId]
  );
}

async function createGoogleEvent(user, booking, BOOKING_FIELDS, USER_FIELDS) {
  if (!user || !user[USER_FIELDS.refresh_token])
    throw new Error("Host user is not linked to Google Calendar.");

  const { BASE_URL } = getDynamicFields();
  const oauth2Client = getOAuthClient(BASE_URL);
  oauth2Client.setCredentials({ refresh_token: user[USER_FIELDS.refresh_token] });
  const calendar = google.calendar({version:"v3",auth:oauth2Client});

  const attendees = pickAttendees(booking, BOOKING_FIELDS);
  const generateMeet = boolConfig("GCAL_GENERATE_MEET_IF_EMPTY", true);
  const wantMeetLink = generateMeet && !booking[BOOKING_FIELDS.meeting_link];

  const eventResource = {
    summary: booking[BOOKING_FIELDS.guest_name]?`Meeting with ${booking[BOOKING_FIELDS.guest_name]}`:"Scheduled Meeting",
    description:"Scheduled via Saltcorn Booking System",
    start:{dateTime: booking[BOOKING_FIELDS.start_time], timeZone:"UTC"},
    end:{dateTime: booking[BOOKING_FIELDS.end_time], timeZone:"UTC"},
    attendees
  };

  if (wantMeetLink) {
    eventResource.conferenceData = {
      createRequest:{
        requestId: `saltcorn-${Date.now()}-${booking[BOOKING_FIELDS.id]}`,
        conferenceSolutionKey:{type:"hangoutsMeet"}
      }
    }
  }

  const calId = user[USER_FIELDS.calendar_id]||"primary";
  const insertRes = await calendar.events.insert({
    calendarId: calId,
    resource:eventResource,
    conferenceDataVersion: wantMeetLink?1:0,
    sendUpdates:"all"
  });

  const event = insertRes.data;
  const meetLink = (event.conferenceData && event.conferenceData.entryPoints?.find(p=>p.entryPointType==="video")?.uri) || event.hangoutLink||"";

  await updateBookingEvent(pluginConfig.BOOKING_TABLE, BOOKING_FIELDS, booking[BOOKING_FIELDS.id], event.id, meetLink);
  return event;
}

function routes() {
  const { BASE_URL, BOOKING_TABLE, USER_TABLE, BOOKING_FIELDS, USER_FIELDS, pluginConfig } = getDynamicFields();
  const router = new Router();

  router.get("/oauth2/init", async (req,res)=>{
    try {
      if (!req.user?.id) return res.status(401).send("Please log in to link Google Calendar.");
      const client = getOAuthClient(BASE_URL);
      const url = client.generateAuthUrl({access_type:"offline",scope:["https://www.googleapis.com/auth/calendar"],prompt:"consent",state:String(req.user.id)});
      return res.redirect(url);
    } catch(e){console.error(e); return res.status(500).send("OAuth init failed.");}
  });

  router.get("/oauth2/callback", async (req,res)=>{
    try {
      const { code, state } = req.query;
      if(!code) return res.status(400).send("Missing code");
      const userId = parseInt(state,10);
      if(!userId) return res.status(400).send("Invalid state");
      const client = getOAuthClient(BASE_URL);
      const { tokens } = await client.getToken(code);
      if(!tokens.refresh_token) return res.status(400).send("No refresh token returned. Remove app from Google permissions and retry.");
      await saveUserTokens(USER_TABLE, USER_FIELDS, userId, tokens.refresh_token, "primary");
      return res.send("✅ Google Calendar linked successfully.");
    } catch(e){console.error(e); return res.status(500).send("OAuth callback failed.");}
  });

 router.post("/bookings/push", async (req,res)=>{
  try{
    const secret = req.get("X-Webhook-Secret");
    if(!secret||secret!==pluginConfig.GOOGLE_SYNC_SECRET) return res.status(401).send("Unauthorized");
    const { booking_id } = req.body || {};
    if(!booking_id) return res.status(400).send("Missing booking_id");
    const booking = await loadBookingById(BOOKING_TABLE, booking_id);
    if(!booking) return res.status(404).send("Booking not found");
    
    const user = await loadUserById(USER_TABLE, USER_FIELDS, booking[BOOKING_FIELDS.host_user_id]);
    if(!user) return res.status(404).send("Host user not found");   // <- fix applied here

    const event = await createGoogleEvent(user, booking, BOOKING_FIELDS, USER_FIELDS);
    return res.json({ok:true, eventId: event.id, meetLink: event.hangoutLink || null});
  } catch(e) {
    console.error(e);
    return res.status(500).send("Push failed");
  }
});


  // Manual admin push for testing
  router.get("/bookings/push/:id", async (req,res)=>{
    try{
      const state = getState();
      const isAdmin = req.user && state.roles_by_id?.[req.user.role_id]?.role==="admin";
      if(!isAdmin) return res.status(403).send("Admins only");
      const bookingId = parseInt(req.params.id,10);
      const booking = await loadBookingById(BOOKING_TABLE, bookingId);
      if(!booking) return res.status(404).send("Booking not found");
      const user = await loadUserById(USER_TABLE, USER_FIELDS, booking[BOOKING_FIELDS.host_user_id]);
      if(!user) return res.status(404).send("Host user not found");
      const event = await createGoogleEvent(user, booking, BOOKING_FIELDS, USER_FIELDS);
      return res.send(`Pushed. Event ID: ${event.id}, Meet link: ${event.hangoutLink || "none"}`);
    } catch(e) {
      console.error(e);
      return res.status(500).send("Manual push failed");
    }
  });

  // Return routes array (Saltcorn requires iterable)
  return [{ route: `/plugin/${PLUGIN_NAME}`, handler: router }];
}

// ============================ PLUGIN EXPORT ===================================
module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: PLUGIN_NAME,
  configuration_workflow,
  routes
};