/**
 * Hardcoded current user/venue for the prototype. There is no auth layer
 * in this codebase; Mariana at The Crescent is the assumed actor for every
 * request, matching the README's "logged in as Mariana" framing.
 *
 * In production these would come from a session cookie / auth provider.
 */

export const CURRENT_USER_ID = "user_mariana";
export const CURRENT_VENUE_ID = "venue_crescent";
