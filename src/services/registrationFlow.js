const mahsoolApiClient = require('./mahsoolApiClient');

// Steps run in order: type -> name -> gender -> dob -> location -> city -> category -> done
// type/gender use reply buttons (<=3 options, fits WhatsApp's button limit).
// location/city/category use list messages with real API ids embedded
// directly in the row id as "<prefix>:<id>", so a reply never needs to be
// re-mapped against a stored position — we just read the id back out.
// city is fetched from /cities/<stateId> once location is picked, matching
// how the website's own registration flow works.
// category supports multi-select via a loop, since WhatsApp list messages
// are single-select per message: pick one -> "add another?" (نعم/لا) ->
// repeat until "لا" or no options remain. subCategory_id/service_id end up
// as the full set of picks. The register endpoint expects BOTH keys present
// on every request — the one that doesn't apply to the chosen type is sent
// as [] rather than omitted, matching what the website actually sends.
// name/dob stay free text — WhatsApp has no interactive widget for open text.

// Mirrors the .refine() conditions in the real RegisterDto schema:
// dob/gender are required for everyone EXCEPT Cooperative, Supplier, and
// ServiceProvider. Of the three types this bot supports, service_provider
// skips them — buyer and farmer both still need dob + gender.
// Kept as a table (not scattered if/else) so a schema change is a one-line
// edit here instead of a step-logic rework.
//
// NOTE: originally this table had `supplier` as the third type, based on
// what the mobile app appeared to support. Confirmed against the live
// website (teerab.mahsool.sd/signup) that its dropdown has no option that
// sends type: "supplier" at all — the "شركة" (company) option actually
// sends type: "service_provider", backed by a real GET /services endpoint.
// service_provider has identical field requirements to supplier in the
// schema, so this was a clean swap once discovered.
const TYPE_RULES = {
  service_provider: { needsDob: false, needsGender: false },
  buyer: { needsDob: true, needsGender: true },
  farmer: { needsDob: true, needsGender: true },
};

function rulesFor(type) {
  return TYPE_RULES[type] || { needsDob: true, needsGender: true }; // safe default if an unexpected type slips through
}

const TYPE_OPTIONS = [
  { id: 'service_provider', title: 'شركة' },
  { id: 'buyer', title: 'مشتري' },
  { id: 'farmer', title: 'مزارع' },
];

const GENDER_OPTIONS = [
  { id: 'male', title: 'ذكر' },
  { id: 'female', title: 'أنثى' },
];


// User types plain YYYY-MM-DD (easier over WhatsApp); the API actually wants
// full RFC3339 (YYYY-MM-DDTHH:mm:ssZ), which we build in webhookController
// User types a date over WhatsApp, which is prone to formatting mistakes:
// wrong separator, day/month swapped, Arabic-Indic digits, etc. Rather than
// rejecting anything that isn't exactly YYYY-MM-DD, parseDob() tries to
// understand what was meant and normalizes it. Only returns null (triggers
// a retry) when it genuinely can't tell, or the result isn't a real
// calendar date.
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function normalizeDigits(str) {
  return str
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isPlausibleBirthYear(year) {
  const currentYear = new Date().getUTCFullYear();
  return year >= 1900 && year <= currentYear;
}

function isValidCalendarDate(year, month, day) {
  if (!isPlausibleBirthYear(year)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Returns "YYYY-MM-DD" or null if the input can't be confidently parsed.
function parseDob(rawInput) {
  if (!rawInput) return null;
  const str = normalizeDigits(rawInput.trim());

  // Contiguous 8 digits: YYYYMMDD (common when someone drops separators)
  if (/^\d{8}$/.test(str)) {
    const year = Number(str.slice(0, 4));
    const month = Number(str.slice(4, 6));
    const day = Number(str.slice(6, 8));
    return isValidCalendarDate(year, month, day) ? `${year}-${pad2(month)}-${pad2(day)}` : null;
  }

  // Split on -, /, ., or whitespace into exactly 3 numeric parts
  const parts = str.split(/[-/.\s]+/).filter(Boolean);
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,4}$/.test(p))) {
    return null;
  }

  const nums = parts.map(Number);
  let year;
  let month;
  let day;

  if (parts[0].length === 4) {
    // YYYY-MM-DD — matches the format we actually prompt for
    [year, month, day] = nums;
  } else if (parts[2].length === 4) {
    // DD-MM-YYYY — the common non-ISO format for Arabic/Sudanese users
    [day, month, year] = nums;
  } else {
    return null; // can't tell which part is the year
  }

  return isValidCalendarDate(year, month, day) ? `${year}-${pad2(month)}-${pad2(day)}` : null;
}

// WhatsApp list messages cap at 10 rows total. Reserve one row for "more"
// when there's another page, so real options per page = 9.
const LIST_PAGE_SIZE = 9;
const ROW_TITLE_MAX = 24; // WhatsApp row title limit
const MORE_ROW_TITLE = 'المزيد ⏵';

function truncate(str, max) {
  const s = String(str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Splits "prefix:rest" on the first colon only (rest may itself contain ':', e.g. "more:2").
function splitId(id) {
  const raw = String(id);
  const idx = raw.indexOf(':');
  if (idx === -1) return [raw, ''];
  return [raw.slice(0, idx), raw.slice(idx + 1)];
}

function buildListMessage(prefix, bodyText, buttonLabel, sectionTitle, options, page) {
  const start = page * LIST_PAGE_SIZE;
  const pageItems = options.slice(start, start + LIST_PAGE_SIZE);
  const hasMore = start + LIST_PAGE_SIZE < options.length;

  const rows = pageItems.map((opt) => ({
    id: `${prefix}:${opt.id}`,
    title: truncate(opt.name, ROW_TITLE_MAX),
  }));

  if (hasMore) {
    rows.push({ id: `${prefix}:more:${page + 1}`, title: MORE_ROW_TITLE });
  }

  return {
    kind: 'list',
    bodyText,
    buttonLabel,
    sections: [{ title: sectionTitle, rows }],
  };
}

// Parses a reply against an expected id prefix for fixed button sets (type/gender).
// Returns the matched option's id, or null if the reply doesn't match.
function matchButton(input, prefix, options) {
  if (input.type !== 'interactive') return null;
  const [p, value] = splitId(input.id);
  if (p !== prefix) return null;
  const match = options.find((o) => o.id === value);
  return match ? match.id : null;
}

// Parses a reply against a paginated list step (location/category).
// Returns { more: pageNumber } for a "more" tap, { value } for a real
// selection, or null if the reply doesn't match this prefix at all.
function parseListReply(input, prefix) {
  if (input.type !== 'interactive') return null;
  const [p, rest] = splitId(input.id);
  if (p !== prefix) return null;

  if (rest.startsWith('more:')) {
    const page = parseInt(rest.slice('more:'.length), 10);
    return Number.isNaN(page) ? null : { more: page };
  }

  const value = Number(rest);
  return Number.isNaN(value) ? null : { value };
}

function typeMessage() {
  return {
    kind: 'buttons',
    bodyText:
      'مرحباً! يبدو أنه ليس لديك حساب مسجل بعد على منصة محصول.\nدعنا ننشئ حساباً جديداً. الرجاء اختيار نوع الحساب:',
    buttons: TYPE_OPTIONS.map((o) => ({ id: `type:${o.id}`, title: o.title })),
  };
}

function nameMessage() {
  return { kind: 'text', text: 'الرجاء إدخال الاسم الكامل:' };
}

function genderMessage() {
  return {
    kind: 'buttons',
    bodyText: 'الرجاء اختيار الجنس:',
    buttons: GENDER_OPTIONS.map((o) => ({ id: `gender:${o.id}`, title: o.title })),
  };
}

function dobMessage() {
  return {
    kind: 'text',
    text: 'الرجاء إدخال تاريخ الميلاد، مثال: 1990-05-20 أو 20-05-1990',
  };
}

function locationMessage(options, page) {
  return buildListMessage('loc', 'الرجاء اختيار المنطقة:', 'اختر المنطقة', 'المناطق', options, page);
}

function cityMessage(options, page) {
  return buildListMessage('city', 'الرجاء اختيار المدينة:', 'اختر المدينة', 'المدن', options, page);
}

function categoryMessage(options, page, isServiceProvider) {
  const bodyText = isServiceProvider ? 'الرجاء اختيار الخدمة:' : 'الرجاء اختيار الفئة:';
  const sectionTitle = isServiceProvider ? 'الخدمات' : 'الفئات';
  return buildListMessage('cat', bodyText, 'اختر', sectionTitle, options, page);
}

// WhatsApp lists are single-select, so multi-select is done as a loop:
// pick one -> ask "add another?" -> repeat until "لا" or nothing left to pick.
function categoryConfirmMessage(isServiceProvider) {
  const label = isServiceProvider ? 'خدمة' : 'فئة';
  return {
    kind: 'buttons',
    bodyText: `هل تريد إضافة ${label} أخرى؟`,
    buttons: [
      { id: 'catadd:yes', title: 'نعم' },
      { id: 'catadd:no', title: 'لا' },
    ],
  };
}

async function enterLocationStep(data) {
  const states = await mahsoolApiClient.getStates();
  return {
    step: 'location',
    data: { ...data, _locationOptions: states },
    message: locationMessage(states, 0),
  };
}

// Register endpoint expects both subCategory_id/service_id keys on every
// request; the one that doesn't apply to this type is sent as [] rather
// than omitted, matching what the website sends.
function finalizeCategorySelection(data, isServiceProvider) {
  const { _categoryOptions, _selectedCategoryIds, ...rest } = data;
  const finalData = { ...rest };
  const ids = _selectedCategoryIds || [];

  if (isServiceProvider) {
    finalData.service_id = ids;
    finalData.subCategory_id = [];
  } else {
    finalData.subCategory_id = ids;
    finalData.service_id = [];
  }

  return { complete: true, data: finalData };
}

async function startFlow() {
  return { step: 'type', data: {}, message: typeMessage() };
}

async function advanceFlow(session, input) {
  const { step, data } = session;

  switch (step) {
    case 'type': {
      const value = matchButton(input, 'type', TYPE_OPTIONS);
      if (!value) return { retry: true, message: typeMessage() };
      return { step: 'name', data: { ...data, type: value }, message: nameMessage() };
    }

    case 'name': {
      if (input.type !== 'text' || input.text.trim().length < 2) {
        return { retry: true, message: nameMessage() };
      }
      const newData = { ...data, name: input.text.trim() };
      const rules = rulesFor(newData.type);

      if (rules.needsGender) {
        return { step: 'gender', data: newData, message: genderMessage() };
      }
      if (rules.needsDob) {
        return { step: 'dob', data: newData, message: dobMessage() };
      }
      return enterLocationStep(newData);
    }

    case 'gender': {
      const value = matchButton(input, 'gender', GENDER_OPTIONS);
      if (!value) return { retry: true, message: genderMessage() };
      const newData = { ...data, gender: value };
      const rules = rulesFor(newData.type);

      if (rules.needsDob) {
        return { step: 'dob', data: newData, message: dobMessage() };
      }
      return enterLocationStep(newData);
    }

    case 'dob': {
      if (input.type !== 'text') {
        return { retry: true, message: dobMessage() };
      }
      const normalized = parseDob(input.text);
      if (!normalized) {
        return { retry: true, message: dobMessage() };
      }
      return enterLocationStep({ ...data, dob: normalized });
    }

    case 'location': {
      const options = data._locationOptions || [];
      const parsed = parseListReply(input, 'loc');
      if (!parsed) return { retry: true, message: locationMessage(options, 0) };

      if (parsed.more !== undefined) {
        return { step: 'location', data, message: locationMessage(options, parsed.more) };
      }

      const matched = options.find((o) => Number(o.id) === parsed.value);
      if (!matched) return { retry: true, message: locationMessage(options, 0) };

      const { _locationOptions, ...rest } = data;
      const cities = await mahsoolApiClient.getCities(matched.id);

      return {
        step: 'city',
        data: { ...rest, location: matched.id, _cityOptions: cities },
        message: cityMessage(cities, 0),
      };
    }

    case 'city': {
      const options = data._cityOptions || [];
      const parsed = parseListReply(input, 'city');
      if (!parsed) return { retry: true, message: cityMessage(options, 0) };

      if (parsed.more !== undefined) {
        return { step: 'city', data, message: cityMessage(options, parsed.more) };
      }

      const matched = options.find((o) => Number(o.id) === parsed.value);
      if (!matched) return { retry: true, message: cityMessage(options, 0) };

      const { _cityOptions, ...rest } = data;
      const isServiceProvider = rest.type === 'service_provider';
      const categoryOptions = isServiceProvider
        ? await mahsoolApiClient.getServices()
        : await mahsoolApiClient.getSubCategories();

      return {
        step: 'category',
        data: { ...rest, city: matched.id, _categoryOptions: categoryOptions },
        message: categoryMessage(categoryOptions, 0, isServiceProvider),
      };
    }

    case 'category': {
      const options = data._categoryOptions || [];
      const isServiceProvider = data.type === 'service_provider';
      const parsed = parseListReply(input, 'cat');
      if (!parsed) return { retry: true, message: categoryMessage(options, 0, isServiceProvider) };

      if (parsed.more !== undefined) {
        return { step: 'category', data, message: categoryMessage(options, parsed.more, isServiceProvider) };
      }

      const matched = options.find((o) => Number(o.id) === parsed.value);
      if (!matched) return { retry: true, message: categoryMessage(options, 0, isServiceProvider) };

      const selectedIds = [...(data._selectedCategoryIds || []), matched.id];
      const remainingOptions = options.filter((o) => o.id !== matched.id);
      const newData = { ...data, _selectedCategoryIds: selectedIds, _categoryOptions: remainingOptions };

      // Nothing left to add — finalize immediately instead of asking a
      // pointless "add another?" with no options to show.
      if (remainingOptions.length === 0) {
        return finalizeCategorySelection(newData, isServiceProvider);
      }

      return {
        step: 'category_confirm',
        data: newData,
        message: categoryConfirmMessage(isServiceProvider),
      };
    }

    case 'category_confirm': {
      const isServiceProvider = data.type === 'service_provider';

      if (input.type !== 'interactive') {
        return { retry: true, message: categoryConfirmMessage(isServiceProvider) };
      }

      const [prefix, value] = splitId(input.id);
      if (prefix !== 'catadd' || (value !== 'yes' && value !== 'no')) {
        return { retry: true, message: categoryConfirmMessage(isServiceProvider) };
      }

      if (value === 'no') {
        return finalizeCategorySelection(data, isServiceProvider);
      }

      // "yes" — show the remaining (not yet picked) options again
      const options = data._categoryOptions || [];
      return {
        step: 'category',
        data,
        message: categoryMessage(options, 0, isServiceProvider),
      };
    }

    default:
      throw new Error(`Unknown registration step: ${step}`);
  }
}

module.exports = { startFlow, advanceFlow };