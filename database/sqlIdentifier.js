'use strict';

// Doubles ']' so a name can be safely interpolated inside a bracket-quoted
// T-SQL identifier ([Foo]]Bar]) - SQL Server's own escaping rule for sysname,
// equivalent to QUOTENAME() but usable where the identifier can't be a query
// parameter (e.g. inside a FROM clause).
function bracketIdentifier(name) {
    return `[${String(name).replace(/]/g, ']]')}]`;
}

// Doubles "'" so a value can be safely interpolated inside a single-quoted
// T-SQL string literal, for the rare case where it can't be a query parameter.
function escapeLiteral(value) {
    return String(value).replace(/'/g, "''");
}

module.exports = { bracketIdentifier, escapeLiteral };
