/**
 * How a person updates this plugin, in the words every notice uses. There is no
 * `/plugin update` session command (code.claude.com plugins/cli-reference: `update`
 * has "no session form"); in a session the path is the Installed tab's Update now.
 * The new version loads after /reload-plugins (or in the next session).
 */
export const UPDATE_HOWTO = "/plugin → Installed → bridge → Update now, then /reload-plugins";
