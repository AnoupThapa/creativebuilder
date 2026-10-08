/* =====================================================================
   PostGenX content library — themes, fonts, template categories.
   Edit this file to add templates; the editor picks them up automatically.
   Template fields (promo): name, headline, sub, price, cta, badge, theme,
     optional: font (heading font), layout ('classic' | 'centered' | 'top' | 'middle')
   Template fields (review): type:'review', name, stars, quote, reviewer, theme
   ===================================================================== */
(function () {
  'use strict';

  const THEMES = {
    modern:  { label:'Modern',  bg:'#1a1a2e', accent:'#ff6b4a', textMain:'#ffffff', textSub:'rgba(255,255,255,.78)', font:'Space Grotesk', ctaStyle:'pill',      overlay:'gradient' },
    minimal: { label:'Minimal', bg:'#f7f5f1', accent:'#1a1a2e', textMain:'#1a1a2e', textSub:'rgba(26,26,46,.65)',    font:'Inter',         ctaStyle:'outline',   overlay:'soft-white' },
    luxury:  { label:'Luxury',  bg:'#0d0d0d', accent:'#d4af37', textMain:'#f5f0e6', textSub:'rgba(245,240,230,.6)',  font:'Playfair Display', ctaStyle:'underline', overlay:'dark' },
    bold:    { label:'Bold',    bg:'#e63946', accent:'#ffd23f', textMain:'#ffffff', textSub:'rgba(255,255,255,.85)', font:'Anton',         ctaStyle:'block',     overlay:'gradient-strong' },
    premium: { label:'Premium', bg:'#1a2e2a', accent:'#3ecf8e', textMain:'#ffffff', textSub:'rgba(255,255,255,.72)', font:'Space Grotesk', ctaStyle:'pill',      overlay:'gradient' },
    festive: { label:'Festive', bg:'#7a1d3d', accent:'#ffd23f', textMain:'#ffffff', textSub:'rgba(255,255,255,.8)',  font:'Poppins',       ctaStyle:'pill',      overlay:'gradient-strong' },
    fresh:   { label:'Fresh',   bg:'#e9f7ef', accent:'#1d7a5f', textMain:'#12372a', textSub:'rgba(18,55,42,.7)',     font:'Poppins',       ctaStyle:'pill',      overlay:'soft-white' },
    ocean:   { label:'Ocean',   bg:'#0b3a5b', accent:'#4fd1ff', textMain:'#ffffff', textSub:'rgba(255,255,255,.78)', font:'Montserrat',    ctaStyle:'pill',      overlay:'gradient' },
    sunset:  { label:'Sunset',  bg:'#ff7e5f', accent:'#2b1055', textMain:'#ffffff', textSub:'rgba(255,255,255,.88)', font:'Poppins',       ctaStyle:'block',     overlay:'gradient-strong' },
    cafe:    { label:'Café',    bg:'#3b2a20', accent:'#e6b980', textMain:'#fff7ec', textSub:'rgba(255,247,236,.75)', font:'DM Serif Display', ctaStyle:'outline', overlay:'dark' },
    pastel:  { label:'Pastel',  bg:'#fdf1f5', accent:'#d6336c', textMain:'#4a1d33', textSub:'rgba(74,29,51,.7)',     font:'Nunito',        ctaStyle:'pill',      overlay:'soft-white' },
    neon:    { label:'Neon',    bg:'#0a0a12', accent:'#39ff14', textMain:'#ffffff', textSub:'rgba(255,255,255,.75)', font:'Bebas Neue',    ctaStyle:'outline',   overlay:'dark' },
    mono:    { label:'Mono',    bg:'#111111', accent:'#ffffff', textMain:'#ffffff', textSub:'rgba(255,255,255,.7)',  font:'Oswald',        ctaStyle:'underline', overlay:'dark' },
    earth:   { label:'Earth',   bg:'#e8dcc8', accent:'#8a5a2b', textMain:'#3a2a1a', textSub:'rgba(58,42,26,.72)',    font:'Merriweather',  ctaStyle:'outline',   overlay:'soft-white' },
  };

  /* Google Fonts available in the editor (loaded by editor.html) */
  const FONTS = [
    { name:'Space Grotesk', kind:'Modern' }, { name:'Inter', kind:'Clean' }, { name:'Fraunces', kind:'Elegant serif' }, { name:'Manrope', kind:'Modern clean' }, { name:'Bricolage Grotesque', kind:'Bold playful' }, { name:'Poppins', kind:'Friendly' },
    { name:'Montserrat', kind:'Geometric' }, { name:'Nunito', kind:'Rounded' }, { name:'Raleway', kind:'Elegant' },
    { name:'Oswald', kind:'Condensed' }, { name:'Bebas Neue', kind:'Headline' }, { name:'Anton', kind:'Impact' },
    { name:'Archivo Black', kind:'Heavy' }, { name:'Playfair Display', kind:'Serif' }, { name:'DM Serif Display', kind:'Serif' },
    { name:'Merriweather', kind:'Serif' }, { name:'Lobster', kind:'Retro script' }, { name:'Pacifico', kind:'Casual script' },
    { name:'Dancing Script', kind:'Script' }, { name:'Caveat', kind:'Handwritten' }, { name:'Courier Prime', kind:'Typewriter' },
    // local languages
    { name:'Mukta', kind:'Clean', lang:'Nepali / Hindi' }, { name:'Hind', kind:'Simple', lang:'Nepali / Hindi' },
    { name:'Baloo 2', kind:'Rounded', lang:'Nepali / Hindi' }, { name:'Yatra One', kind:'Headline', lang:'Nepali / Hindi' },
    { name:'Rozha One', kind:'Bold serif', lang:'Nepali / Hindi' }, { name:'Tiro Devanagari Hindi', kind:'Classic', lang:'Nepali / Hindi' },
    { name:'Kalam', kind:'Handwritten', lang:'Nepali / Hindi' }, { name:'Noto Sans Devanagari', kind:'Plain', lang:'Nepali / Hindi' },
    { name:'Noto Serif Devanagari', kind:'Serif', lang:'Nepali / Hindi' },
    { name:'Hind Siliguri', kind:'Clean', lang:'Bengali' }, { name:'Noto Sans Bengali', kind:'Plain', lang:'Bengali' },
    { name:'Hind Vadodara', kind:'Clean', lang:'Gujarati' }, { name:'Noto Sans Gujarati', kind:'Plain', lang:'Gujarati' },
    { name:'Baloo Paaji 2', kind:'Rounded', lang:'Punjabi' }, { name:'Noto Sans Gurmukhi', kind:'Plain', lang:'Punjabi' },
    { name:'Catamaran', kind:'Clean', lang:'Tamil' }, { name:'Noto Sans Tamil', kind:'Plain', lang:'Tamil' },
    { name:'Noto Sans Telugu', kind:'Plain', lang:'Telugu' }, { name:'Noto Sans Kannada', kind:'Plain', lang:'Kannada' },
    { name:'Noto Sans Malayalam', kind:'Plain', lang:'Malayalam' }, { name:'Noto Sans Sinhala', kind:'Plain', lang:'Sinhala' },
    { name:'Kanit', kind:'Modern', lang:'Thai' }, { name:'Prompt', kind:'Friendly', lang:'Thai' }, { name:'Noto Sans Thai', kind:'Plain', lang:'Thai' },
    { name:'Cairo', kind:'Modern', lang:'Arabic / Urdu' }, { name:'Tajawal', kind:'Clean', lang:'Arabic / Urdu' },
    { name:'Noto Naskh Arabic', kind:'Classic', lang:'Arabic / Urdu' }, { name:'Noto Sans Arabic', kind:'Plain', lang:'Arabic / Urdu' },
    { name:'Noto Sans Hebrew', kind:'Plain', lang:'Hebrew' }, { name:'Noto Sans Myanmar', kind:'Plain', lang:'Burmese' },
    { name:'Noto Sans Khmer', kind:'Plain', lang:'Khmer' }, { name:'Noto Serif Tibetan', kind:'Serif', lang:'Tibetan' },
  ];

  const LAYOUTS = [
    { key:'classic', label:'Classic' }, { key:'centered', label:'Centred' },
    { key:'top', label:'Text on top' }, { key:'middle', label:'Middle' },
  ];

  const T = (name, headline, sub, price, cta, badge, theme, extra) => Object.assign({ name, headline, sub, price, cta, badge, theme }, extra || {});
  const R = (name, stars, quote, reviewer, theme) => ({ type:'review', name, stars, quote, reviewer, theme });

  const TEMPLATES = {
    restaurant: [
      T("Today's Special", "Today's Special", "Chef's recommendation", 'Rs. 199', 'Order Now', 'HOT', 'modern'),
      T('Weekend Offer', 'Weekend Feast', 'Available Sat & Sun only', '20% OFF', 'Book Today', 'LIMITED OFFER', 'bold', { layout:'centered' }),
      T('Lunch Combo', 'Lunch Combo Deal', 'Mon–Fri 12–3 PM', 'Rs. 299', 'Order Now', 'BEST SELLER', 'premium'),
      T('New Menu Item', 'New On The Menu', "Try it before it's gone", '', 'Explore Now', 'NEW', 'minimal', { layout:'top' }),
      T('Family Night', 'Family Dinner Night', 'Kids eat free every Tuesday', '', 'Reserve Now', 'HOT', 'sunset', { layout:'centered' }),
      T('Delivery', 'Hot Food, Delivered', 'Free delivery over $30', 'Free Delivery', 'Order Now', '', 'cafe'),
    ],
    cafe: [
      T('Coffee Promo', 'Start Your Day Right', 'Freshly brewed daily', '20% OFF', 'Order Now', 'HOT', 'cafe'),
      T('Happy Hour', 'Happy Hour', '2 PM – 5 PM every day', 'Buy 1 Get 1', 'Visit Store', 'LIMITED OFFER', 'festive', { layout:'centered' }),
      T('New Beverage', 'New Sip Arrived', 'Try our latest creation', '', 'Explore Now', 'NEW', 'pastel', { layout:'top' }),
      T('Loyalty Card', 'Your 10th Coffee Is On Us', 'Ask for a loyalty card today', 'FREE', 'Visit Store', '', 'earth'),
      T('Breakfast', 'All-Day Breakfast', 'Eggs, toast & a flat white', '$15', 'Order Now', 'BEST SELLER', 'cafe', { layout:'middle' }),
    ],
    bakery: [
      T('Fresh Bread', 'Fresh From The Oven', 'Baked every morning at 6 AM', '', 'Visit Store', 'NEW', 'earth', { font:'DM Serif Display' }),
      T('Cake Orders', 'Custom Birthday Cakes', 'Order 48 hours ahead', 'From $45', 'Message Us', '', 'pastel', { font:'Pacifico', layout:'centered' }),
      T('Dozen Deal', 'Buy 10, Get 12', 'Donuts, muffins & cookies', '2 FREE', 'Shop Now', 'HOT', 'sunset', { layout:'centered' }),
      T('End of Day', 'Evening Bread Sale', 'Everything half price after 5 PM', '50% OFF', 'Visit Store', 'LIMITED OFFER', 'cafe'),
    ],
    retail: [
      T('Flash Sale', 'Flash Sale', 'Ends midnight tonight', '50% OFF', 'Shop Now', '50% OFF', 'bold', { layout:'centered' }),
      T('New Arrival', 'Just Arrived', 'Fresh styles in store', '', 'Explore Now', 'NEW', 'minimal'),
      T('Clearance Sale', 'Clearance Sale', 'While stocks last', 'Up to 70% OFF', 'Shop Now', 'SALE', 'festive'),
      T('Free Shipping', 'Free Shipping Weekend', 'On every order, no minimum', 'FREE', 'Shop Now', '', 'ocean', { layout:'top' }),
      T('Bundle', 'Bundle & Save', 'Any 3 items', '$99', 'Shop Now', 'BEST SELLER', 'neon', { font:'Bebas Neue' }),
    ],
    clothing: [
      T('New Collection', 'New Collection', 'Drop 2026', '', 'Explore Now', 'NEW', 'luxury', { layout:'middle' }),
      T('Flat Discount', 'Flat 30% Off', 'All clothing this week', '30% OFF', 'Shop Now', 'SALE', 'bold'),
      T('Festive Collection', 'Festive Picks', 'Dress for the season', '', 'Shop Now', 'HOT', 'festive', { layout:'centered' }),
      T('Lookbook', 'The Summer Edit', 'Light layers for warm days', '', 'Explore Now', '', 'mono', { font:'Oswald', layout:'top' }),
    ],
    beauty: [
      T('Bridal Package', 'Bridal Package', 'Complete bridal makeover', 'Book Now', 'Book Today', 'LIMITED OFFER', 'luxury'),
      T('Hair Treatment', 'Hair Treatment', 'Nourish & restore shine', '20% OFF', 'Book Today', 'HOT', 'premium'),
      T('Beauty Package', 'Pamper Day', 'Facial, massage & manicure', '$89', 'Reserve Now', 'NEW', 'pastel', { font:'Playfair Display', layout:'centered' }),
      T('Nails', 'Fresh Set Friday', 'Gel nails in 45 minutes', '$35', 'Book Today', '', 'neon'),
      T('Barber', 'Sharp Cut, Sharp Look', 'Walk-ins welcome', '$25', 'Book Today', '', 'mono', { font:'Bebas Neue' }),
    ],
    fitness: [
      T('Join Now', 'No Joining Fee', 'This month only', '$0 Joining', 'Get Started', 'LIMITED OFFER', 'neon', { font:'Bebas Neue', layout:'centered' }),
      T('Free Trial', '7-Day Free Pass', 'Classes, gym & pool', 'FREE', 'Learn More', 'NEW', 'bold'),
      T('Personal Training', 'Train With A Pro', '1-on-1 sessions', '3 for $120', 'Book Today', '', 'mono', { font:'Oswald' }),
      T('Yoga', 'Sunrise Yoga', 'Every weekday at 6:30 AM', '', 'Book Today', '', 'fresh', { font:'Raleway', layout:'top' }),
    ],
    grocery: [
      T('Weekly Specials', "This Week's Specials", 'Fresh produce at farm prices', 'Save 25%', 'Visit Store', 'SALE', 'fresh'),
      T('Organic', 'Organic & Local', 'Straight from nearby farms', '', 'Shop Now', 'NEW', 'earth', { layout:'centered' }),
      T('Home Delivery', 'Groceries To Your Door', 'Same-day delivery', 'Free over $50', 'Order Now', '', 'ocean'),
    ],
    pharmacy: [
      T('Flu Season', 'Flu Shots Available', 'Walk in — no appointment needed', '', 'Visit Store', 'NEW', 'fresh'),
      T('Health Check', 'Free Blood Pressure Check', 'Every Saturday morning', 'FREE', 'Visit Store', '', 'ocean', { layout:'centered' }),
      T('Vitamins', 'Vitamin Week', 'Selected brands', '30% OFF', 'Shop Now', 'SALE', 'minimal'),
    ],
    realestate: [
      T('Just Listed', 'Just Listed', '3 bed · 2 bath · double garage', '$749,000', 'Learn More', 'NEW', 'luxury', { font:'Playfair Display' }),
      T('Open Home', 'Open Home Saturday', '10:00 – 10:30 AM', '', 'Message Us', '', 'minimal', { layout:'top' }),
      T('Sold', 'SOLD', 'Thinking of selling? Free appraisal', '', 'Get Quote', 'HOT', 'bold', { font:'Anton', layout:'centered' }),
      T('For Rent', 'For Rent', 'Modern 2-bed apartment, city views', '$620 / week', 'Call Now', '', 'ocean'),
    ],
    hotel: [
      T('Weekend Escape', 'Weekend Escape', '2 nights + breakfast for two', '$299', 'Book Today', 'LIMITED OFFER', 'luxury', { layout:'middle' }),
      T('Early Bird', 'Book Early, Save More', '60 days ahead', '25% OFF', 'Book Today', 'SALE', 'ocean'),
      T('Trekking', 'Trek & Stay Package', 'Guides, meals & lodge included', 'From $450', 'Message Us', 'HOT', 'earth', { layout:'top' }),
    ],
    service: [
      T('Special Offer', 'Special Offer', 'For new customers', '20% OFF', 'Get Quote', 'LIMITED OFFER', 'modern'),
      T('Book Appointment', 'Book Now', 'Limited slots available', '', 'Book Today', '', 'minimal', { layout:'centered' }),
      T('Seasonal Promo', 'Season Special', 'Offer ends soon', '', 'Call Now', 'HOT', 'bold'),
      T('Cleaning', 'Spotless Home Clean', 'Insured, police-checked team', 'From $99', 'Get Quote', '', 'fresh'),
      T('Car Service', 'Full Car Service', 'Oil, filters & 50-point check', '$149', 'Book Today', 'BEST SELLER', 'mono', { font:'Oswald' }),
      T('Tutoring', 'After-School Tutoring', 'Maths & English, years 1–12', 'First class free', 'Book Today', 'NEW', 'ocean', { layout:'top' }),
    ],
    events: [
      T('Live Music', 'Live Music Tonight', 'Doors open 7 PM', 'Free Entry', 'Learn More', 'HOT', 'neon', { font:'Bebas Neue', layout:'centered' }),
      T('Workshop', 'Weekend Workshop', 'Limited to 12 people', '$49', 'Book Today', 'LIMITED OFFER', 'earth'),
      T('Grand Opening', 'Grand Opening!', 'Free gifts for the first 50', '', 'Visit Store', 'NEW', 'festive', { layout:'middle' }),
    ],
    festival: [
      T('New Year', 'Happy New Year!', 'Wishing you joy & success', '', 'Shop Now', '', 'festive', { layout:'middle' }),
      T('Dashain', 'Shubha Dashain', 'Celebrating togetherness', '30% OFF', 'Shop Now', 'SALE', 'festive'),
      T('Tihar', 'Shubha Tihar', 'Light up your celebrations', '', 'Shop Now', 'HOT', 'festive', { layout:'centered' }),
      T('Diwali', 'Happy Diwali', 'Festival of lights offers', '25% OFF', 'Shop Now', 'SALE', 'sunset', { layout:'centered' }),
      T('Holi', 'Happy Holi', 'Colour your day with savings', '', 'Shop Now', '', 'pastel', { font:'Pacifico', layout:'middle' }),
      T('Eid', 'Eid Mubarak', 'Warm wishes to you and your family', '', 'Visit Store', '', 'premium', { font:'DM Serif Display', layout:'middle' }),
      T('Lunar New Year', 'Happy Lunar New Year', 'Prosperity & good fortune', '', 'Shop Now', '', 'festive', { layout:'centered' }),
      T("Valentine's Day", 'Share the Love', 'For someone special', '', 'Shop Now', 'HOT', 'bold', { font:'Lobster' }),
      T("Mother's Day", 'For The Best Mum', "Mother's Day gifts", '', 'Shop Now', '', 'pastel', { font:'Dancing Script', layout:'centered' }),
      T("Father's Day", 'Happy Father’s Day', 'Gifts he will actually use', '', 'Shop Now', '', 'mono'),
      T('Easter', 'Happy Easter', 'Treats for the whole family', '', 'Visit Store', '', 'fresh', { layout:'centered' }),
      T('Black Friday', 'Black Friday', 'Our biggest sale of the year', 'Up to 60% OFF', 'Shop Now', 'SALE', 'neon', { font:'Anton', layout:'centered' }),
      T('EOFY', 'End Of Financial Year Sale', 'Ends 30 June', '40% OFF', 'Shop Now', 'SALE', 'ocean'),
      T('Halloween', 'Spooky Savings', 'Halloween week only', '31% OFF', 'Shop Now', 'HOT', 'sunset'),
      T('Christmas', 'Merry Christmas', "Season's greetings", '', 'Shop Now', '', 'festive', { layout:'middle' }),
    ],
    testimonial: [
      R('5-Star Rave', 5, 'Best food in town, we come back every week!', 'Sarah M.', 'modern'),
      R('Quick Thanks', 5, 'Fast service and super friendly staff. Highly recommend!', 'Rajesh K.', 'minimal'),
      R('Product Love', 5, 'Exactly what I needed — great quality for the price.', 'Priya S.', 'premium'),
      R('Loyal Customer', 4, 'Been coming here for years, never disappoints.', 'David L.', 'luxury'),
      R('Coffee Fan', 5, 'The flat white here is the best in the city. Lovely people too.', 'Emma W.', 'cafe'),
      R('Salon Review', 5, 'My hair has never looked this good. Booking again already!', 'Anita G.', 'pastel'),
      R('Service Review', 5, 'On time, tidy and fairly priced. Would use again.', 'Tom H.', 'fresh'),
    ],
  };

  const CATEGORIES = [
    { key:'restaurant',  label:'🍽 Restaurant' },
    { key:'cafe',        label:'☕ Café' },
    { key:'bakery',      label:'🥐 Bakery' },
    { key:'retail',      label:'🛍 Retail & online' },
    { key:'clothing',    label:'👗 Clothing' },
    { key:'grocery',     label:'🥦 Grocery' },
    { key:'service',     label:'🔧 Services' },
    { key:'testimonial', label:'💬 Customer review', premium:true },
    { key:'beauty',      label:'💅 Salon & beauty',  premium:true },
    { key:'fitness',     label:'🏋️ Gym & fitness',   premium:true },
    { key:'pharmacy',    label:'💊 Pharmacy',        premium:true },
    { key:'realestate',  label:'🏠 Real estate',     premium:true },
    { key:'hotel',       label:'🏨 Hotel & travel',  premium:true },
    { key:'events',      label:'🎤 Events',          premium:true },
    { key:'festival',    label:'🎉 Festivals & holidays', premium:true },
  ];

  window.PF_CONTENT = { THEMES, FONTS, LAYOUTS, TEMPLATES, CATEGORIES };
})();
