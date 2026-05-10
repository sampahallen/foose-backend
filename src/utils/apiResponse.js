const success = (res, data = {}, message = "OK", statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    data,
    message,
  });
};

const error = (res, errorMessage = "Server Error", statusCode = 500, details) => {
  const payload = {
    success: false,
    error: errorMessage,
  };

  if (details) payload.details = details;

  return res.status(statusCode).json(payload);
};

module.exports = {
  success,
  error,
};
