const httpError = (statusCode, message, details) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
};

module.exports = httpError;
