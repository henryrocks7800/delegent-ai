// What a surface says when setting up a connection does not go to plan.
//
// Both surfaces implemented this list separately and drifted: the phone said
// "Couldn't reach your coworker" where the browser said "We could not reach
// your coworker", for the identical situation. One home for the wording is the
// only thing that stops that happening again.

export const CONNECTIONS_SIGN_IN_AGAIN = 'Sign in again, then set this up.';

export const CONNECTIONS_NO_PLAN = 'Connections need an active plan. Pick a plan to turn them on.';

export const CONNECTIONS_WORKSPACE_STARTING =
  'Your coworker’s workspace is still coming online. Try again in a moment.';

export const CONNECTIONS_UNREACHABLE = 'We could not reach your coworker. Try again in a moment.';

export const CONNECTIONS_RATE_LIMITED = 'That was a lot at once. Give it a few seconds and try again.';

export const CONNECTIONS_NOT_TURNED_ON = 'This one isn’t ready to connect yet. It’s coming shortly.';

// Every message above tells the reader to try again, and neither surface gave
// them anything to try again with. The phone left a red line at the top of the
// drawer and the browser a red bar at the top of the page, both of which could
// only be cleared by closing the screen and opening it afresh, which is a thing
// you have to already know to do.
export const CONNECTIONS_RETRY_LABEL = 'Try again';

// Coming back from the provider is no longer the end of it: the grant is stored
// behind a signed-in request, so there is a beat between the browser handing
// back and the connection existing. Without a line for that beat the reader
// watches a screen that still says Connect and reasonably presses it again.
export const CONNECTIONS_FINISHING_LABEL = 'Finishing off, one moment…';

// Disconnect is a promise that access stops. One service can hold more than one
// grant, so a partial removal has to say so: the reader has just been told that
// their coworker can no longer reach the account, and it still can.
export const CONNECTIONS_PARTLY_DISCONNECTED =
  'Some of that account is still connected, so your coworker may still be able to reach it. Try again in a moment.';

export const CONNECTIONS_DISCONNECT_UNCONFIRMED =
  'We could not confirm that was disconnected. Check its status below before relying on it.';
