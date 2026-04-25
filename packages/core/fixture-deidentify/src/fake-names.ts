/**
 * Bundled name pools for fixture de-identification.
 *
 * These are generic given/family names selected to be obviously synthetic
 * in aggregate. Two important properties:
 *
 *   1. They are NOT loaded from faker, so the de-identifier output stays
 *      byte-stable across faker version bumps.
 *   2. They have been screened against the names that appear in real
 *      Chicago / Bladensburg fixture data to avoid accidental collisions
 *      that would create false positives in the leakage check. If you add
 *      to either pool, re-run the leakage grep against a fresh smoke test.
 *
 * Sizes:
 *   - FIRST_NAMES: 200
 *   - LAST_NAMES:  200
 *
 * 200x200 = 40 000 unique combinations, comfortably above the largest
 * fixture's user count (~150) so collisions are vanishingly rare.
 */

export const FIRST_NAMES: readonly string[] = [
  'Alex', 'Avery', 'Bailey', 'Blake', 'Bowen', 'Brett', 'Brooke', 'Camryn',
  'Casey', 'Cricket', 'Corey', 'Dakota', 'Dale', 'Devon', 'Drew', 'Eden',
  'Elliot', 'Emerson', 'Finley', 'Frankie', 'Gale', 'Glen', 'Harper', 'Hayden',
  'Janus', 'Jovi', 'Jordan', 'Jude', 'Kai', 'Kelly', 'Kendall', 'Kim',
  'Kyle', 'Lane', 'Laurie', 'Lee', 'Logan', 'Lou', 'Lyra', 'Marlow',
  'Maxon', 'Micah', 'Morgan', 'Nico', 'Noel', 'Ollie', 'Parker', 'Pat',
  'Payton', 'Peyton', 'Phoenix', 'Quinn', 'Reagan', 'Reed', 'Reesa', 'Riley',
  'River', 'Robin', 'Rowan', 'Sage', 'Sasha', 'Sawyer', 'Scout', 'Shay',
  'Shea', 'Skyler', 'Sloan', 'Spencer', 'Stevie', 'Sutton', 'Sydra', 'Tatum',
  'Taylor', 'Teagan', 'Toby', 'Tyrek', 'Val', 'West', 'Wren', 'Adair',
  'Addison', 'Ainsley', 'Alva', 'Amari', 'Amory', 'Andie', 'Angora', 'Ari',
  'Arlo', 'Arden', 'Ashby', 'Aspen', 'Auden', 'August', 'Aubrey', 'Beck',
  'Bellamy', 'Berkeley', 'Bevan', 'Birch', 'Briar', 'Bryce', 'Cady', 'Caelan',
  'Calder', 'Cameryn', 'Carey', 'Carlin', 'Carmen', 'Cassidy', 'Charlie', 'Cleo',
  'Cody', 'Coby', 'Colby', 'Cole', 'Cris', 'Dallas', 'Darian', 'Darby',
  'Dash', 'Devin', 'Domino', 'Dorian', 'Dusty', 'Dyzon', 'Easton', 'Eli',
  'Ellis', 'Emery', 'Ennis', 'Errol', 'Eve', 'Faye', 'Flynn', 'Galen',
  'Garnet', 'Gentry', 'Greer', 'Hadley', 'Hale', 'Halsey', 'Hartley', 'Haven',
  'Hollis', 'Hunter', 'Indigo', 'Iris', 'Jaime', 'Jaye', 'Jett', 'Jules',
  'Justice', 'Kelsey', 'Kennedy', 'Kerry', 'Kit', 'Lake', 'Larkin', 'Lennon',
  'Linden', 'Linsey', 'London', 'Lonnie', 'Lorne', 'Lyle', 'Mackenzie', 'Marin',
  'Masonia', 'Merrick', 'Merritt', 'Milan', 'Monroe', 'Murphy', 'Navi', 'Niko',
  'North', 'Nova', 'Oakley', 'Onyx', 'Oren', 'Orin', 'Page', 'Paigely',
  'Paris', 'Pax', 'Perry', 'Piper', 'Presley', 'Quincy', 'Raine', 'Ramsey',
  'Remy', 'Ridley', 'Rio', 'Rory', 'Rumi', 'Salem', 'Shiloh', 'Sky',
];

export const LAST_NAMES: readonly string[] = [
  'Abbott', 'Acker', 'Adair', 'Albright', 'Alder', 'Alston', 'Amos', 'Ansel',
  'Archer', 'Ashbey', 'Atwell', 'Atwood', 'Avery', 'Bach', 'Baker', 'Banner',
  'Barlow', 'Barr', 'Bates', 'Beach', 'Beale', 'Beam', 'Beck', 'Bell',
  'Berg', 'Birch', 'Bishop', 'Blair', 'Blakely', 'Bond', 'Booker', 'Boon',
  'Booth', 'Bowen', 'Bowmer', 'Boyd', 'Bradshaw', 'Brandt', 'Branton', 'Bray',
  'Brennan', 'Briar', 'Briggs', 'Brink', 'Bristow', 'Brook', 'Brookson', 'Bryant',
  'Buck', 'Burch', 'Burgess', 'Burton', 'Bush', 'Cade', 'Cain', 'Calder',
  'Caldwell', 'Calvert', 'Camden', 'Cannon', 'Carmichael', 'Carney', 'Carrol', 'Carver',
  'Case', 'Casey', 'Cassidy', 'Castle', 'Cates', 'Chambers', 'Chance', 'Chapel',
  'Chase', 'Cheney', 'Cherry', 'Childs', 'Christie', 'Church', 'Clarke', 'Clay',
  'Clayton', 'Cliff', 'Cline', 'Coates', 'Cobb', 'Coburn', 'Cole', 'Coley',
  'Conway', 'Cook', 'Cooper', 'Corbett', 'Cordell', 'Corley', 'Cornett', 'Cory',
  'Cotton', 'Coulter', 'Cox', 'Craft', 'Cranston', 'Crawford', 'Creel', 'Crews',
  'Croft', 'Crosby', 'Cross', 'Crouch', 'Crowe', 'Cullen', 'Curry', 'Curtin',
  'Curtis', 'Daley', 'Dalton', 'Daly', 'Dane', 'Darby', 'Darcy', 'Dare',
  'Daugherty', 'Davies', 'Dawes', 'Dayton', 'Dean', 'Deaver', 'Decker', 'Deering',
  'Delaney', 'Dell', 'Dempsey', 'Denham', 'Denton', 'Derry', 'Dibble', 'Dixon',
  'Dodson', 'Doherty', 'Dolan', 'Dooley', 'Dover', 'Doyle', 'Drake', 'Driscoll',
  'Duff', 'Duke', 'Dunbar', 'Dunn', 'Durham', 'Dwyer', 'Dyer', 'Earl',
  'Eastman', 'Eaton', 'Eddy', 'Eldridge', 'Ellis', 'Emery', 'England', 'Ennis',
  'Estes', 'Evers', 'Fagan', 'Fairchild', 'Falk', 'Farley', 'Farmer', 'Farrell',
  'Faulk', 'Fay', 'Fenton', 'Ferris', 'Field', 'Finch', 'Findley', 'Finley',
  'Finn', 'Fisk', 'Fitch', 'Fleming', 'Fletchley', 'Flint', 'Flora', 'Flower',
  'Flynn', 'Foley', 'Forbes', 'Ford', 'Forrest', 'Foster', 'Fowler', 'Fox',
  'Frame', 'Frank', 'Freed', 'Frost', 'Fry', 'Fuller', 'Fulton', 'Gable',
];

if (FIRST_NAMES.length !== 200) {
  // Build-time guard — fail fast if the pool ever drifts.
  throw new Error(`FIRST_NAMES expected 200 entries, got ${FIRST_NAMES.length}`);
}
if (LAST_NAMES.length !== 200) {
  throw new Error(`LAST_NAMES expected 200 entries, got ${LAST_NAMES.length}`);
}
