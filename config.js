/* Supervisor app settings. READ-ONLY data: put only the channel ID and (for a private channel) the READ key here.
   NEVER put the WRITE key in this folder: everything in app/ is public once hosted. */
window.HELMET_CONFIG = {
  channelId: 3583714,   // ThingSpeak channel ID (public channel)
  readKey: "",          // leave "" for a public channel; a private channel needs its READ API key (see docs/app.md)
  pollSeconds: 15,      // ThingSpeak free license: updates are at most every 15 s
  results: 120          // entries asked for per poll (the trend needs the last 60 minutes)
};
