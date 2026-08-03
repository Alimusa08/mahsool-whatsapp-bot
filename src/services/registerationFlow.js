const mahsoolApiClient = require('./mahsoolApiClient');

// Steps run in this order: type -> name -> gender -> dob -> location -> category -> done
// "category" collects subCategory_id for buyer/farmer, or service_id for supplier.
// city and cooperative-only fields are intentionally not collected — city is
// optional and not part of this flow, cooperative isn't a supported type here.

const TYPE_OPTIONS = [
  { value: 'supplier', label: 'مورد' },
  { value: 'buyer', label: 'مشتري' },
  { value: 'farmer', label: 'مزارع' },
];

const GENDER_OPTIONS = [
  { value: 'male', label: 'ذكر' },
  { value: 'female', label: 'أنثى' },
];

// Hardcoded to match the mobile app — there is no endpoint for this list.
const SERVICE_OPTIONS = [
  { id: 1, name: 'نقل' },
  { id: 2, name: 'تخزين' },
  { id: 3, name: 'عمالة' },
];

const DOB_REGEX = /^\d{4}-\d{2}-\d{2}$/; // ASSUMPTION: API expects YYYY-MM-DD; confirm against schema/docs.

function renderMenu(options, labelKey) {
  return options.map((opt, i) => `${i + 1}. ${opt[labelKey]}`).join('\n');
}

function parseSingleChoice(input, count) {
  const n = parseInt(String(input).trim(), 10);
  if (Number.isNaN(n) || n < 1 || n > count) return null;
  return n;
}

// Accepts comma/space-separated numbers, e.g. "1,3" or "1 3"; dedupes.
function parseMultiChoice(input, count) {
  const parts = String(input).split(/[,،\s]+/).filter(Boolean);
  if (parts.length === 0) return null;

  const nums = [];
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < 1 || n > count) return null;
    nums.push(n);
  }
  return [...new Set(nums)];
}

function typePrompt() {
  return (
    'مرحباً! يبدو أنه ليس لديك حساب مسجل بعد على منصة محصول.\n' +
    'دعنا ننشئ حساباً جديداً. الرجاء اختيار نوع الحساب:\n' +
    renderMenu(TYPE_OPTIONS, 'label')
  );
}

function namePrompt() {
  return 'الرجاء إدخال الاسم الكامل:';
}

function genderPrompt() {
  return `الرجاء اختيار الجنس:\n${renderMenu(GENDER_OPTIONS, 'label')}`;
}

function dobPrompt() {
  return 'الرجاء إدخال تاريخ الميلاد بصيغة (سنة-شهر-يوم)، مثال: 1990-05-20';
}

function locationPrompt(stateOptions) {
  return `الرجاء اختيار المنطقة:\n${renderMenu(stateOptions, 'name')}`;
}

function categoryPrompt(categoryOptions) {
  return (
    'الرجاء اختيار الفئة المناسبة (يمكنك اختيار أكثر من رقم مفصولة بفاصلة، مثال: 1,3):\n' +
    renderMenu(categoryOptions, 'name')
  );
}

// Starts a fresh registration session for a phone number.
async function startFlow() {
  return {
    step: 'type',
    data: {},
    replyText: typePrompt(),
  };
}

// Advances an existing session given the user's latest message.
// Returns one of:
//   { retry: true, replyText }                      — invalid input, same step repeated
//   { step, data, replyText }                        — advanced to the next step
//   { complete: true, data }                         — all fields collected, ready to register
async function advanceFlow(session, userInput) {
  const { step, data } = session;
  const trimmed = (userInput || '').trim();

  switch (step) {
    case 'type': {
      const choice = parseSingleChoice(trimmed, TYPE_OPTIONS.length);
      if (!choice) {
        return { retry: true, replyText: `اختيار غير صالح.\n${typePrompt()}` };
      }
      return {
        step: 'name',
        data: { ...data, type: TYPE_OPTIONS[choice - 1].value },
        replyText: namePrompt(),
      };
    }

    case 'name': {
      if (trimmed.length < 2) {
        return { retry: true, replyText: `الاسم قصير جداً.\n${namePrompt()}` };
      }
      return {
        step: 'gender',
        data: { ...data, name: trimmed },
        replyText: genderPrompt(),
      };
    }

    case 'gender': {
      const choice = parseSingleChoice(trimmed, GENDER_OPTIONS.length);
      if (!choice) {
        return { retry: true, replyText: `اختيار غير صالح.\n${genderPrompt()}` };
      }
      return {
        step: 'dob',
        data: { ...data, gender: GENDER_OPTIONS[choice - 1].value },
        replyText: dobPrompt(),
      };
    }

    case 'dob': {
      if (!DOB_REGEX.test(trimmed)) {
        return { retry: true, replyText: `صيغة غير صحيحة.\n${dobPrompt()}` };
      }
      const states = await mahsoolApiClient.getStates();
      return {
        step: 'location',
        data: { ...data, dob: trimmed, _locationOptions: states },
        replyText: locationPrompt(states),
      };
    }

    case 'location': {
      const options = data._locationOptions || [];
      const choice = parseSingleChoice(trimmed, options.length);
      if (!choice) {
        return { retry: true, replyText: `اختيار غير صالح.\n${locationPrompt(options)}` };
      }

      const { _locationOptions, ...rest } = data;
      const locationId = options[choice - 1].id;

      if (rest.type === 'supplier') {
        return {
          step: 'category',
          data: { ...rest, location: locationId, _categoryOptions: SERVICE_OPTIONS },
          replyText: categoryPrompt(SERVICE_OPTIONS),
        };
      }

      const subCategories = await mahsoolApiClient.getSubCategories();
      return {
        step: 'category',
        data: { ...rest, location: locationId, _categoryOptions: subCategories },
        replyText: categoryPrompt(subCategories),
      };
    }

    case 'category': {
      const options = data._categoryOptions || [];
      const choices = parseMultiChoice(trimmed, options.length);
      if (!choices) {
        return { retry: true, replyText: `اختيار غير صالح.\n${categoryPrompt(options)}` };
      }

      const selectedIds = choices.map((n) => options[n - 1].id);
      const { _categoryOptions, ...rest } = data;
      const finalData = { ...rest };

      if (rest.type === 'supplier') {
        finalData.service_id = selectedIds;
      } else {
        finalData.subCategory_id = selectedIds;
      }

      return { complete: true, data: finalData };
    }

    default:
      throw new Error(`Unknown registration step: ${step}`);
  }
}

module.exports = { startFlow, advanceFlow };