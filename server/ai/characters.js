'use strict';
/* AI models (made-up adult presenters) who show a customer's product in photos and presenter videos.
   Every character is fictional — never a real person or celebrity. The same character keeps the same face:
   with a real AI key a photoreal reference portrait is made once and reused as a reference for every job. */

// a: avatar drawing for the picker (skin, hair colour, hair style, outfit colour, extras)
const CHARACTERS = [
  { key: 'maya', name: 'Maya', group: 'Young adults', age: '20s', role: 'Friendly young woman',
    desc: 'a friendly South Asian woman in her mid-20s with long dark wavy hair, warm brown eyes, natural light makeup, wearing a casual cream knit top',
    a: { skin: '#c68a5e', hair: '#1f1611', style: 'long', outfit: '#f1e3cf', g: 'f' } },
  { key: 'arjun', name: 'Arjun', group: 'Young adults', age: '20s', role: 'Friendly young man',
    desc: 'a friendly South Asian man in his late 20s with short neat black hair and a light trimmed beard, wearing a plain navy crew-neck t-shirt',
    a: { skin: '#b27a52', hair: '#16110d', style: 'short', outfit: '#2b3a67', g: 'm', beard: true } },
  { key: 'lin', name: 'Lin', group: 'Young adults', age: '20s', role: 'Trendy young woman',
    desc: 'a stylish East Asian woman in her mid-20s with a sleek shoulder-length black bob, wearing a pastel lavender oversized shirt',
    a: { skin: '#f0cfae', hair: '#14110f', style: 'bob', outfit: '#cdb8ec', g: 'f' } },
  { key: 'kofi', name: 'Kofi', group: 'Young adults', age: '20s', role: 'Energetic young man',
    desc: 'an upbeat Black African man in his mid-20s with short curly black hair and a bright smile, wearing a mustard-yellow hoodie',
    a: { skin: '#6e4528', hair: '#0f0b08', style: 'curly', outfit: '#e2a72e', g: 'm' } },
  { key: 'sofia', name: 'Sofia', group: 'Lifestyle', age: '30s', role: 'Lifestyle presenter',
    desc: 'a warm European woman in her early 30s with light-brown hair in a loose ponytail, wearing a soft sage-green linen shirt',
    a: { skin: '#f2d2b6', hair: '#7a5232', style: 'pony', outfit: '#a9c3a0', g: 'f' } },
  { key: 'omar', name: 'Omar', group: 'Lifestyle', age: '30s', role: 'Lifestyle presenter',
    desc: 'a confident Middle Eastern man in his early 30s with short dark hair and a neat beard, wearing a white linen shirt',
    a: { skin: '#c99a73', hair: '#1b130e', style: 'short', outfit: '#f4f1ea', g: 'm', beard: true } },
  { key: 'priya', name: 'Priya', group: 'Professionals', age: '40s', role: 'Mid-aged professional woman',
    desc: 'a polished South Asian businesswoman in her mid-40s with shoulder-length dark hair, wearing a tailored charcoal blazer over a white blouse',
    a: { skin: '#b98260', hair: '#1c1410', style: 'bob', outfit: '#3b3f47', g: 'f', collar: '#ffffff' } },
  { key: 'daniel', name: 'Daniel', group: 'Professionals', age: '40s', role: 'Mid-aged professional man',
    desc: 'a trustworthy European businessman in his mid-40s with short brown hair greying at the temples, wearing a navy suit, light-blue shirt and no tie',
    a: { skin: '#eac2a0', hair: '#5b4636', style: 'short', outfit: '#23304f', g: 'm', collar: '#cfe0f2' } },
  { key: 'grace', name: 'Grace', group: 'Professionals', age: '40s', role: 'Mid-aged professional woman',
    desc: 'a confident Black businesswoman in her mid-40s with short natural hair, wearing a deep-teal tailored blazer',
    a: { skin: '#7a4c2e', hair: '#120d0a', style: 'curly', outfit: '#1f6b6b', g: 'f' } },
  { key: 'helen', name: 'Helen', group: 'Senior executives', age: '60s', role: 'Senior executive woman',
    desc: 'an elegant senior executive woman in her early 60s with short silver hair and thin-rimmed glasses, wearing a camel blazer and pearl stud earrings',
    a: { skin: '#efc9a9', hair: '#c9c6c2', style: 'bob', outfit: '#b08955', g: 'f', glasses: true } },
  { key: 'robert', name: 'Robert', group: 'Senior executives', age: '60s', role: 'Senior executive man',
    desc: 'a distinguished senior executive man in his early 60s with neatly combed silver-grey hair and a short grey beard, wearing a charcoal suit and white shirt',
    a: { skin: '#e3b897', hair: '#bdb8b2', style: 'short', outfit: '#3a3a40', g: 'm', beard: true, collar: '#ffffff' } },
  { key: 'raj', name: 'Mr. Shrestha', group: 'Senior executives', age: '60s', role: 'Senior South Asian executive',
    desc: 'a respected senior South Asian businessman in his early 60s with short grey hair and rimless glasses, wearing a dark-grey suit with a subtle tie',
    a: { skin: '#a8714d', hair: '#a9a5a0', style: 'short', outfit: '#44474f', g: 'm', glasses: true, collar: '#ffffff' } },
  { key: 'chef', name: 'Chef Bikash', group: 'Lifestyle', age: '40s', role: 'Chef',
    desc: 'a cheerful South Asian chef in his 40s wearing a clean white chef jacket, with short black hair',
    a: { skin: '#a5704a', hair: '#15100c', style: 'short', outfit: '#ffffff', g: 'm' } },
  { key: 'mia_fit', name: 'Mia', group: 'Lifestyle', age: '20s', role: 'Fitness coach',
    desc: 'an energetic athletic woman in her late 20s with a high ponytail, wearing a plain teal sports top',
    a: { skin: '#e6b892', hair: '#3a2617', style: 'pony', outfit: '#1aa59a', g: 'f' } },
  { key: 'anita', name: 'Anita', group: 'Lifestyle', age: '30s', role: 'Parent & home',
    desc: 'a warm, approachable South Asian mother in her late 30s with her hair in a low bun, wearing a soft coral cardigan',
    a: { skin: '#bf8761', hair: '#1d1510', style: 'bun', outfit: '#ef8e7c', g: 'f' } },
];

/* what the model does with the product (photos) */
const ACTIONS = {
  hold: { label: 'Holding it to the camera', text: 'holds {product} up near their face at chest height with one hand, label facing the camera, presenting it proudly' },
  use: { label: 'Using it', text: 'is naturally using {product} in a realistic everyday moment, with the product clearly visible and facing the camera' },
  point: { label: 'Pointing at it', text: 'stands beside {product}, which sits on a clean surface in front of them, and gestures towards it with an open hand while smiling at the camera' },
  desk: { label: 'At a desk / office', text: 'sits at a tidy modern desk with {product} placed prominently in front of them, looking confidently at the camera' },
  table: { label: 'At a table / counter', text: 'stands behind a clean counter with {product} on it in the foreground, leaning slightly forward with a warm, welcoming smile' },
};
/* the look of the picture */
const LOOKS = {
  studio: { label: 'Studio ad', text: 'Professional advertising photo: soft studio lighting, clean seamless background in a colour that suits the product, shallow depth of field, sharp focus on the person and the product.' },
  lifestyle: { label: 'Lifestyle', text: 'Lifestyle advertising photo in a bright, tidy real-world setting that suits the product (home, café, office or shop), natural window light, shallow depth of field.' },
  selfie: { label: 'Phone selfie (UGC look)', text: 'Casual vertical smartphone-camera look, as if filmed by the presenter themselves at arm’s length, natural indoor light, authentic and unpolished but clean and well lit — styled like creator content, not a professional shoot.' },
};

const byKey = k => CHARACTERS.find(c => c.key === k) || null;
const pub = c => ({ key: c.key, name: c.name, group: c.group, age: c.age, role: c.role, avatar: `/img/characters/${c.key}.png` });

/* Phrases that would turn an AI presenter into a fake customer testimonial (not allowed: the person does not exist). */
const TESTIMONIAL = [
  /\bI(?:'ve|’ve| have) been \w+ing\b/i, /\bI(?:'ve|’ve| have) (?:used|tried|bought|ordered|had)\b/i, /\bI (?:bought|ordered|tried|use|used|wear|eat|drink)\b/i,
  /\b(?:since I started|after (?:a|one|two|three) (?:weeks?|months?) of using)\b/i,
  /\bmy (?:skin|hair|face|kids?|family|husband|wife|results?|life|customers)\b/i, /\bchanged my life\b/i,
  /\bas a (?:real |happy |satisfied |loyal )?customer\b/i, /\b(?:honest|real|genuine) review\b/i,
  /\bI (?:can'?t|cannot) live without\b/i, /\bI (?:highly )?recommend (?:it|this) (?:to|because) (?:everyone|all)\b.*\bI\b/i,
  /\b(?:मैले|मेरो) (?:प्रयोग|किनें)/, /\bमैंने .*(?:इस्तेमाल|खरीदा)/,
];
function testimonialProblem(script) {
  const s = String(script || '');
  const hit = TESTIMONIAL.find(r => r.test(s));
  return hit ? (s.match(hit) || [''])[0] : '';
}

module.exports = { CHARACTERS, ACTIONS, LOOKS, byKey, pub, testimonialProblem };
