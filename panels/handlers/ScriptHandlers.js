'use strict';

class ScriptHandlers {
    constructor(postMessage, scriptGeneratorService) {
        this._post = postMessage;
        this._scriptGeneratorService = scriptGeneratorService;
    }

    async handleGenerateScript(database, objectName, objectType, scriptType) {
        try {
            const script = await this._scriptGeneratorService.generateScript(database, objectName, objectType, scriptType);
            this._post({ command: 'scriptGenerated', objectName, scriptType, script });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to generate script: ${error.message}` });
        }
    }
}

module.exports = ScriptHandlers;
