const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    params: req.params,
    query: req.query,
  });

  if (!result.success) {
    return res.status(422).json({
      success: false,
      error: "Validation failed",
      details: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  req.validated = result.data;
  req.body = result.data.body;
  req.params = result.data.params;
  next();
};

module.exports = validate;
