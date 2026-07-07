'use strict';

class CommentsHandlers {
    constructor(postMessage, commentsService) {
        this._post = postMessage;
        this._commentsService = commentsService;
    }

    async handleGetTableExtendedProperties(database, tableName) {
        try {
            const properties = await this._commentsService.getTableExtendedProperties(database, tableName);
            this._post({ command: 'tableExtendedPropertiesResult', tableName, properties });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get table extended properties: ${error.message}` });
        }
    }

    async handleGetObjectExtendedProperties(database, objectName, objectType) {
        try {
            const properties = await this._commentsService.getObjectExtendedProperties(database, objectName, objectType);
            this._post({ command: 'objectExtendedPropertiesResult', objectName, objectType, properties });
        } catch (error) {
            this._post({ command: 'error', message: `Failed to get object extended properties: ${error.message}` });
        }
    }

    async handleUpdateTableDescription(database, tableName, description) {
        try {
            const result = await this._commentsService.updateTableDescription(database, tableName, description);
            this._post({ command: 'updateDescriptionResult', success: result.success, message: result.message, type: 'table', tableName });
        } catch (error) {
            this._post({ command: 'updateDescriptionResult', success: false, message: `Failed to update table description: ${error.message}`, type: 'table', tableName });
        }
    }

    async handleUpdateColumnDescription(database, tableName, columnName, description) {
        try {
            const result = await this._commentsService.updateColumnDescription(database, tableName, columnName, description);
            this._post({ command: 'updateDescriptionResult', success: result.success, message: result.message, type: 'column', tableName, columnName });
        } catch (error) {
            this._post({ command: 'updateDescriptionResult', success: false, message: `Failed to update column description: ${error.message}`, type: 'column', tableName, columnName });
        }
    }

    async handleUpdateObjectDescription(database, objectName, objectType, description) {
        try {
            const result = await this._commentsService.updateObjectDescription(database, objectName, objectType, description);
            this._post({ command: 'updateDescriptionResult', success: result.success, message: result.message, type: 'object', objectName });
        } catch (error) {
            this._post({ command: 'updateDescriptionResult', success: false, message: `Failed to update object description: ${error.message}`, type: 'object', objectName });
        }
    }

    async handleDeleteTableDescription(database, tableName) {
        try {
            const result = await this._commentsService.deleteTableDescription(database, tableName);
            this._post({ command: 'deleteDescriptionResult', success: result.success, message: result.message, type: 'table', tableName });
        } catch (error) {
            this._post({ command: 'deleteDescriptionResult', success: false, message: `Failed to delete table description: ${error.message}`, type: 'table', tableName });
        }
    }

    async handleDeleteColumnDescription(database, tableName, columnName) {
        try {
            const result = await this._commentsService.deleteColumnDescription(database, tableName, columnName);
            this._post({ command: 'deleteDescriptionResult', success: result.success, message: result.message, type: 'column', tableName, columnName });
        } catch (error) {
            this._post({ command: 'deleteDescriptionResult', success: false, message: `Failed to delete column description: ${error.message}`, type: 'column', tableName, columnName });
        }
    }
}

module.exports = CommentsHandlers;
