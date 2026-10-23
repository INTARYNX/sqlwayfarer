
USE master;
GO

-- Sécurité : ne pas écraser une base existante.
IF DB_ID(N'BigObjectTest') IS NOT NULL
    THROW 50001,
      'BigObjectTest existe déjà. Utilisez un autre nom ou supprimez-la manuellement.', 1;
GO

CREATE DATABASE BigObjectTest;
GO

USE BigObjectTest;
GO

SET NOCOUNT ON;

DECLARE @i int;
DECLARE @s int;
DECLARE @schema sysname;
DECLARE @obj sysname;
DECLARE @targetSchema sysname;
DECLARE @targetTable sysname;
DECLARE @sql nvarchar(max);

--------------------------------------------------
-- 1. CREATION DE 200 SCHEMAS
--------------------------------------------------
SET @i = 1;

WHILE @i <= 200
BEGIN
    SET @schema = N'TestSchema_' +
        RIGHT(N'000' + CONVERT(nvarchar(3), @i), 3);

    SET @sql = N'CREATE SCHEMA ' + QUOTENAME(@schema) + N';';
    EXEC sys.sp_executesql @sql;

    SET @i += 1;
END;

--------------------------------------------------
-- 2. CREATION DE 5000 TABLES
--------------------------------------------------
SET @i = 1;

WHILE @i <= 5000
BEGIN
    SET @s = ((@i - 1) % 200) + 1;

    SET @schema = N'TestSchema_' +
        RIGHT(N'000' + CONVERT(nvarchar(3), @s), 3);

    SET @obj = N'TestTable_' +
        RIGHT(N'00000' + CONVERT(nvarchar(5), @i), 5);

    SET @sql =
        N'CREATE TABLE ' + QUOTENAME(@schema) +
        N'.' + QUOTENAME(@obj) + N' (
            Id int NOT NULL,
            Code varchar(50) NULL,
            CreatedAt datetime2 NULL,
            Amount decimal(18,2) NULL
        );';

    EXEC sys.sp_executesql @sql;

    SET @i += 1;
END;

--------------------------------------------------
-- 3. CREATION DE 1000 VUES
--------------------------------------------------
SET @i = 1;

WHILE @i <= 1000
BEGIN
    SET @s = ((@i - 1) % 200) + 1;

    SET @schema = N'TestSchema_' +
        RIGHT(N'000' + CONVERT(nvarchar(3), @s), 3);

    SET @targetSchema = N'TestSchema_' +
        RIGHT(N'000' +
            CONVERT(nvarchar(3), ((@i - 1) % 200) + 1), 3);

    SET @targetTable = N'TestTable_' +
        RIGHT(N'00000' +
            CONVERT(nvarchar(5), ((@i - 1) % 5000) + 1), 5);

    SET @obj = N'TestView_' +
        RIGHT(N'0000' + CONVERT(nvarchar(4), @i), 4);

    SET @sql =
        N'CREATE VIEW ' + QUOTENAME(@schema) +
        N'.' + QUOTENAME(@obj) +
        N' AS SELECT Id, Code, CreatedAt, Amount FROM ' +
        QUOTENAME(@targetSchema) + N'.' +
        QUOTENAME(@targetTable) + N';';

    EXEC sys.sp_executesql @sql;

    SET @i += 1;
END;

--------------------------------------------------
-- 4. CREATION DE 2000 PROCEDURES STOCKEES
--------------------------------------------------
SET @i = 1;

WHILE @i <= 2000
BEGIN
    SET @s = ((@i - 1) % 200) + 1;

    SET @schema = N'TestSchema_' +
        RIGHT(N'000' + CONVERT(nvarchar(3), @s), 3);

    SET @targetSchema = N'TestSchema_' +
        RIGHT(N'000' +
            CONVERT(nvarchar(3), ((@i - 1) % 200) + 1), 3);

    SET @targetTable = N'TestTable_' +
        RIGHT(N'00000' +
            CONVERT(nvarchar(5), ((@i - 1) % 5000) + 1), 5);

    SET @obj = N'TestProcedure_' +
        RIGHT(N'0000' + CONVERT(nvarchar(4), @i), 4);

    SET @sql =
        N'CREATE PROCEDURE ' + QUOTENAME(@schema) +
        N'.' + QUOTENAME(@obj) +
        N' AS BEGIN SET NOCOUNT ON; SELECT COUNT_BIG(*) AS TotalRows FROM ' +
        QUOTENAME(@targetSchema) + N'.' +
        QUOTENAME(@targetTable) + N'; END;';

    EXEC sys.sp_executesql @sql;

    SET @i += 1;
END;

--------------------------------------------------
-- 5. CREATION DE 1000 FONCTIONS SCALAIRES
--------------------------------------------------
SET @i = 1;

WHILE @i <= 1000
BEGIN
    SET @s = ((@i - 1) % 200) + 1;

    SET @schema = N'TestSchema_' +
        RIGHT(N'000' + CONVERT(nvarchar(3), @s), 3);

    SET @obj = N'TestFunction_' +
        RIGHT(N'0000' + CONVERT(nvarchar(4), @i), 4);

    SET @sql =
        N'CREATE FUNCTION ' + QUOTENAME(@schema) +
        N'.' + QUOTENAME(@obj) +
        N'(@Value int) RETURNS int AS BEGIN RETURN @Value + ' +
        CONVERT(nvarchar(10), @i) + N'; END;';

    EXEC sys.sp_executesql @sql;

    SET @i += 1;
END;

--------------------------------------------------
-- 6. CREATION DE 500 TRIGGERS
--------------------------------------------------
SET @i = 1;

WHILE @i <= 500
BEGIN
    SET @s = ((@i - 1) % 200) + 1;

    SET @schema = N'TestSchema_' +
        RIGHT(N'000' + CONVERT(nvarchar(3), @s), 3);

    SET @targetSchema = @schema;

    SET @targetTable = N'TestTable_' +
        RIGHT(N'00000' + CONVERT(nvarchar(5), @i), 5);

    SET @obj = N'TestTrigger_' +
        RIGHT(N'0000' + CONVERT(nvarchar(4), @i), 4);

    SET @sql =
        N'CREATE TRIGGER ' + QUOTENAME(@schema) +
        N'.' + QUOTENAME(@obj) +
        N' ON ' + QUOTENAME(@targetSchema) +
        N'.' + QUOTENAME(@targetTable) +
        N' AFTER INSERT AS BEGIN SET NOCOUNT ON; END;';

    EXEC sys.sp_executesql @sql;

    SET @i += 1;
END;

--------------------------------------------------
-- 7. INVENTAIRE FINAL
--------------------------------------------------
SELECT
    type,
    type_desc,
    COUNT_BIG(*) AS Nombre
FROM sys.objects
WHERE is_ms_shipped = 0
GROUP BY type, type_desc
ORDER BY type_desc;

SELECT
    (SELECT COUNT(*) FROM sys.schemas
     WHERE name LIKE 'TestSchema[_]%') AS Schemas,
    (SELECT COUNT(*) FROM sys.tables
     WHERE name LIKE 'TestTable[_]%') AS Tables,
    (SELECT COUNT(*) FROM sys.views
     WHERE name LIKE 'TestView[_]%') AS Vues,
    (SELECT COUNT(*) FROM sys.procedures
     WHERE name LIKE 'TestProcedure[_]%') AS Procedures,
    (SELECT COUNT(*) FROM sys.objects
     WHERE type = 'FN'
       AND name LIKE 'TestFunction[_]%') AS Fonctions,
    (SELECT COUNT(*) FROM sys.triggers
     WHERE name LIKE 'TestTrigger[_]%') AS Triggers;
GO
