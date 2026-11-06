'use strict';

// UPDATE and DELETE statements without a WHERE clause.
const TSqlParserVisitor = require('./generated/TSqlParserVisitor');
const { extractFromDdlObject } = require('./sqlParseHelpers');

// Flags UPDATE/DELETE statements that have no WHERE clause. `ctx.WHERE()` returns
// null when the clause is absent (and also covers WHERE CURRENT OF, which is fine:
// a positioned cursor update is not a mass write).
class RiskVisitor extends TSqlParserVisitor {
    constructor() {
        super();
        this.risks = []; // { type: 'UPDATE'|'DELETE', table: string|null }
    }

    visitUpdate_statement(ctx) {
        if (!ctx.WHERE()) {
            this.risks.push({ type: 'UPDATE', table: extractFromDdlObject(ctx.ddl_object ? ctx.ddl_object() : null) });
        }
        this.visitChildren(ctx);
    }

    visitDelete_statement(ctx) {
        if (!ctx.WHERE()) {
            const from = ctx.delete_statement_from ? ctx.delete_statement_from() : null;
            const ddl = from && from.ddl_object ? from.ddl_object() : null;
            this.risks.push({ type: 'DELETE', table: extractFromDdlObject(ddl) });
        }
        this.visitChildren(ctx);
    }
}

module.exports = RiskVisitor;
