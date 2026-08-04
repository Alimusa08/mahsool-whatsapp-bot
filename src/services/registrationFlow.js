const mahsoolApiClient = require('./mahsoolApiClient');

// Steps run in order: type -> name -> gender -> dob -> location -> category -> done
// type/gender use reply buttons (<=3 options, fits WhatsApp's button limit).
// location/category use list messages with real API ids embedded directly in
// the row id as "<prefix>:<id>", so a reply never needs to be re-mapped
// against a stored position — we just read the id back out.
// category is single-select for now (WhatsApp lists have no native
// multi-select), so subCategory_id/service_id always end up as one-element
// arrays here.
// name/dob stay free text — WhatsApp has no interactive widget for open text.

const TYPE_OPTIONS = [
  { id: 'supplier', title: 'مورد' },
  { id: 'buyer', title: 'مشتري' },
  { id: 'farmer', title: 'مزارع' },
];

const GENDER_OPTIONS = [
  { id: 'male', title: 'ذكر' },
  { id: 'female', title: 'أنثى' },
];

// Hardcoded to match the mobile app — there is no endpoint for this list.
const SERVICE_OPTIONS = [
  { id: 1, name: 'نقل' },
  { id: 2, name: 'تخزين' },
  { id: 3, name: 'عمالة' },
];

const DOB_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// User types plain YYYY-MM-DD (easier over WhatsApp); the API actually wants
// full RFC3339 (YYYY-MM-DDTHH:mm:ssZ), which we build in webhookController
// right before calling /auth/register — see toRfc3339Date().
// This also rejects calendar-invalid dates like 2023-02-30, which the regex
// alone would let through.
function isValidDob(str) {
  if (!DOB_REGEX.test(str)) return false;
  const [year, month, day] = str.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
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
  return { kind: 'text', text: 'الرجاء إدخال تاريخ الميلاد بصيغة (سنة-شهر-يوم)، مثال: 1990-05-20' };
}

function locationMessage(options, page) {
  return buildListMessage('loc', 'الرجاء اختيار المنطقة:', 'اختر المنطقة', 'المناطق', options, page);
}

function categoryMessage(options, page, isSupplier) {
  const bodyText = isSupplier ? 'الرجاء اختيار الخدمة:' : 'الرجاء اختيار الفئة:';
  const sectionTitle = isSupplier ? 'الخدمات' : 'الفئات';
  return buildListMessage('cat', bodyText, 'اختر', sectionTitle, options, page);
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
      return { step: 'gender', data: { ...data, name: input.text.trim() }, message: genderMessage() };
    }

    case 'gender': {
      const value = matchButton(input, 'gender', GENDER_OPTIONS);
      if (!value) return { retry: true, message: genderMessage() };
      return { step: 'dob', data: { ...data, gender: value }, message: dobMessage() };
    }

    case 'dob': {
      if (input.type !== 'text' || !isValidDob(input.text.trim())) {
        return { retry: true, message: dobMessage() };
      }
      const states = await mahsoolApiClient.getStates();
      return {
        step: 'location',
        data: { ...data, dob: input.text.trim(), _locationOptions: states },
        message: locationMessage(states, 0),
      };
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
      const isSupplier = rest.type === 'supplier';
      const categoryOptions = isSupplier ? SERVICE_OPTIONS : await mahsoolApiClient.getSubCategories();

      return {
        step: 'category',
        data: { ...rest, location: matched.id, _categoryOptions: categoryOptions },
        message: categoryMessage(categoryOptions, 0, isSupplier),
      };
    }

    case 'category': {
      const options = data._categoryOptions || [];
      const isSupplier = data.type === 'supplier';
      const parsed = parseListReply(input, 'cat');
      if (!parsed) return { retry: true, message: categoryMessage(options, 0, isSupplier) };

      if (parsed.more !== undefined) {
        return { step: 'category', data, message: categoryMessage(options, parsed.more, isSupplier) };
      }

      const matched = options.find((o) => Number(o.id) === parsed.value);
      if (!matched) return { retry: true, message: categoryMessage(options, 0, isSupplier) };

      const { _categoryOptions, ...rest } = data;
      const finalData = { ...rest };
      if (isSupplier) {
        finalData.service_id = [matched.id];
      } else {
        finalData.subCategory_id = [matched.id];
      }

      return { complete: true, data: finalData };
    }

    default:
      throw new Error(`Unknown registration step: ${step}`);
  }
}

module.exports = { startFlow, advanceFlow };