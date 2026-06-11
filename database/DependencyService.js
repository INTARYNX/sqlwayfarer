'use strict';

class DependencyService {
    constructor() {
        this._indexService = null;
    }

    setIndexService(indexService) {
        this._indexService = indexService;
    }

    async getDependencies(database, objectName) {
        try {
            if (!this._indexService) return { dependsOn: [], referencedBy: [] };

            const index = await this._indexService.getIndex(database);
            if (!index || !index.objects) return { dependsOn: [], referencedBy: [] };

            const cleanName = objectName.replace(/[\[\]]/g, '');
            let objectData = index.objects[cleanName];

            if (!objectData) {
                for (const [key, obj] of Object.entries(index.objects)) {
                    if (key.toLowerCase() === cleanName.toLowerCase() ||
                        obj.name === cleanName || obj.qualifiedName === cleanName) {
                        objectData = obj;
                        break;
                    }
                }
            }

            if (!objectData) return { dependsOn: [], referencedBy: [] };

            const dependsOn = (objectData.dependencies || []).map(dep => ({
                referenced_object: dep,
                referenced_object_type: this._getTypeFromCode(index.objects[dep]?.type),
                dependency_type: 'REFERENCE',
                operations: ['REFERENCE'],
                is_selected: 1,
                is_updated: 0,
                is_insert_all: 0,
                is_delete: 0
            }));

            const referencedBy = [];
            for (const [key, obj] of Object.entries(index.objects)) {
                if (!obj.dependencies?.length) continue;
                const matches = obj.dependencies.some(dep => {
                    const clean = dep.replace(/[\[\]]/g, '');
                    return clean === cleanName || clean.toLowerCase() === cleanName.toLowerCase() ||
                        dep === objectName || dep === cleanName;
                });
                if (matches) {
                    referencedBy.push({
                        referencing_object: obj.name || key,
                        referencing_object_type: this._getTypeFromCode(obj.type),
                        dependency_type: 'REFERENCE'
                    });
                }
            }

            return { dependsOn, referencedBy };
        } catch (error) {
            console.error('Error getting dependencies:', error);
            return { dependsOn: [], referencedBy: [] };
        }
    }

    async getDependencyTree(database, objectName, maxDepth = 3) {
        try {
            if (!this._indexService) return { name: objectName, dependencies: [] };

            const index = await this._indexService.getIndex(database);
            if (!index || !index.objects) return { name: objectName, dependencies: [] };

            const visited = new Set();

            const buildTree = (objName, level) => {
                if (level >= maxDepth || visited.has(objName)) return { name: objName, dependencies: [] };
                visited.add(objName);

                const data = index.objects[objName.replace(/[\[\]]/g, '')];
                if (!data?.dependencies) { visited.delete(objName); return { name: objName, dependencies: [] }; }

                const children = data.dependencies.map(dep => buildTree(dep, level + 1));
                visited.delete(objName);
                return { name: objName, dependencies: children };
            };

            return buildTree(objectName, 0);
        } catch (error) {
            console.error('Tree error:', error);
            return { name: objectName, dependencies: [] };
        }
    }

    async getImpactAnalysis(database, objectName) {
        const deps = await this.getDependencies(database, objectName);
        return deps.referencedBy || [];
    }

    _getTypeFromCode(typeCode) {
        const types = { 'U': 'Table', 'V': 'View', 'P': 'Procedure', 'FN': 'Function', 'IF': 'Function', 'TF': 'Function', 'TR': 'Trigger' };
        return types[(typeCode || '').trim()] || 'Object';
    }

    dispose() {}
}

module.exports = DependencyService;
