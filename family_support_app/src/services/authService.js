const bcrypt = require('bcryptjs');
const { USER_ACCOUNTS_FILE, EMPLOYEE_ACCOUNTS_FILE, loadJson, saveJson } = require('./dataService');

const DEFAULT_USERS = {
  admin: {
    password: "admin123",
    role: "admin",
    name: "المدير",
    governorate: ""
  },
  employee: {
    password: "employee123",
    role: "employee",
    name: "موظف",
    governorate: ""
  },
  psychologist: {
    password: "psych123",
    role: "psychologist",
    name: "أخصائي نفسي",
    governorate: ""
  },
  user: {
    password: "user123",
    role: "user",
    name: "مستخدم عادي",
    governorate: ""
  }
};

function getAllUsers() {
  const users = { ...DEFAULT_USERS };
  const userAccounts = loadJson(USER_ACCOUNTS_FILE, {});
  const employeeAccounts = loadJson(EMPLOYEE_ACCOUNTS_FILE, {});

  Object.assign(users, userAccounts, employeeAccounts);
  return users;
}

function verifyPassword(plainPassword, storedHashOrPlain) {
  if (!storedHashOrPlain || !plainPassword) return false;
  // If stored as plaintext (e.g. default credentials)
  if (plainPassword === storedHashOrPlain) return true;
  // If stored as bcrypt hash
  if (storedHashOrPlain.startsWith('$2a$') || storedHashOrPlain.startsWith('$2b$')) {
    try {
      return bcrypt.compareSync(plainPassword, storedHashOrPlain);
    } catch {
      return false;
    }
  }
  // Support python werkzeug scrypt hashes or hash fallback
  return plainPassword === storedHashOrPlain;
}

function hashPassword(plainPassword) {
  return bcrypt.hashSync(plainPassword, 10);
}

function registerUser(username, password, name) {
  const users = getAllUsers();
  if (users[username]) {
    return { ok: false, msg: "اسم المستخدم مسجل بالفعل" };
  }
  const accounts = loadJson(USER_ACCOUNTS_FILE, {});
  accounts[username] = {
    password: hashPassword(password),
    role: "user",
    name: name || username,
    governorate: ""
  };
  saveJson(USER_ACCOUNTS_FILE, accounts);
  return { ok: true, msg: "تم إنشاء الحساب بنجاح" };
}

function registerEmployee(username, password, name, governorate = "", role = "employee") {
  const users = getAllUsers();
  if (users[username]) {
    return { ok: false, msg: "اسم المستخدم مسجل بالفعل" };
  }
  const accounts = loadJson(EMPLOYEE_ACCOUNTS_FILE, {});
  accounts[username] = {
    password: hashPassword(password),
    role: role || "employee",
    name: name || username,
    governorate: governorate || ""
  };
  saveJson(EMPLOYEE_ACCOUNTS_FILE, accounts);
  return { ok: true, msg: "تم إنشاء الحساب بنجاح" };
}

function changeUserPassword(username, newPassword) {
  const userAccounts = loadJson(USER_ACCOUNTS_FILE, {});
  const employeeAccounts = loadJson(EMPLOYEE_ACCOUNTS_FILE, {});
  const hashedPassword = hashPassword(newPassword);

  if (userAccounts[username]) {
    userAccounts[username].password = hashedPassword;
    saveJson(USER_ACCOUNTS_FILE, userAccounts);
    return true;
  }
  if (employeeAccounts[username]) {
    employeeAccounts[username].password = hashedPassword;
    saveJson(EMPLOYEE_ACCOUNTS_FILE, employeeAccounts);
    return true;
  }
  // Default system users
  if (DEFAULT_USERS[username]) {
    DEFAULT_USERS[username].password = hashedPassword;
    return true;
  }
  return false;
}

module.exports = {
  getAllUsers,
  verifyPassword,
  hashPassword,
  registerUser,
  registerEmployee,
  changeUserPassword
};
