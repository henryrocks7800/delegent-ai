// What a surface says when a routine was created but the list refresh that
// follows the create could not be done.
//
// The two steps go to different places: the create is a Worker call, the list
// is a direct read. So the create can succeed and the read that follows it
// fail, and the only thing left on screen is a read error over a list that does
// not contain the routine just made. Read as "it did not save", and the natural
// response is to make it again, which is a second standing job firing on its
// own schedule that nobody meant to set up.

export const ROUTINE_CREATED_REFRESH_FAILED =
  'Your routine is set up and will run as scheduled. We just could not refresh this list.';

// How many standing routines one account can hold, counting paused ones,
// because a paused row still occupies the list and can be woken with one tap.
// Fifty is far past any real use and matches the most either surface will
// list, so nothing can exist that the screen cannot show. The Worker enforces
// it at create time; without a ceiling a scripted client could insert rows
// without bound, each one a job the five-minute sweep must consider forever.
export const ROUTINE_MAX_STANDING = 50;

export const ROUTINE_LIMIT_REACHED_MESSAGE =
  `You already have ${ROUTINE_MAX_STANDING} routines, which is the most an account can hold. Delete one you no longer use, then set this one up.`;
