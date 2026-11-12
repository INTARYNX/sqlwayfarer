-- A small database for a screenshot of the write footprint: what a procedure
-- really touches once the triggers have fired.
--
--   sqlcmd -S localhost -E -i test\tools\createFootprintDemo.sql      (drops WayfarerDemo first, then recreates it)
--
-- usp_PlaceOrder writes two tables. The system views (sys.sql_expression_dependencies)
-- stop there. The triggers carry its writes to four more tables, over three hops:
--
--   usp_PlaceOrder -> Orders      -> trg_Orders_Balance      -> CustomerBalance          (MERGE)
--                  -> OrderLines  -> trg_OrderLines_Stock    -> Stock, StockMovements
--                                    Stock -> trg_Stock_Audit -> AuditLog
--
-- What a text search gets wrong is in there too: a CTE named like a table,
-- inserted / deleted in the triggers, and (usp_Notes) names that sit in a comment
-- (ignored) or in a string (listed as possible).
-- usp_CloseDay writes its statement as a literal string: the tool finds the table.
-- usp_Purge builds it from a parameter: nothing can be found, and the tool says so.
USE master;
GO
IF DB_ID('WayfarerDemo') IS NOT NULL
BEGIN
    ALTER DATABASE WayfarerDemo SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE WayfarerDemo;
END
GO
CREATE DATABASE WayfarerDemo;
GO
USE WayfarerDemo;
GO
CREATE TABLE dbo.Customers (
    CustomerID int IDENTITY PRIMARY KEY,
    Name nvarchar(100) NOT NULL,
    Country char(2) NOT NULL
);
CREATE TABLE dbo.Products (
    ProductID int IDENTITY PRIMARY KEY,
    Name nvarchar(100) NOT NULL,
    UnitPrice decimal(10,2) NOT NULL
);
CREATE TABLE dbo.Orders (
    OrderID int IDENTITY PRIMARY KEY,
    CustomerID int NOT NULL REFERENCES dbo.Customers(CustomerID),
    OrderDate datetime2(0) NOT NULL DEFAULT SYSDATETIME(),
    Total decimal(12,2) NOT NULL DEFAULT 0
);
CREATE TABLE dbo.OrderLines (
    OrderLineID int IDENTITY PRIMARY KEY,
    OrderID int NOT NULL REFERENCES dbo.Orders(OrderID),
    ProductID int NOT NULL REFERENCES dbo.Products(ProductID),
    Quantity int NOT NULL,
    UnitPrice decimal(10,2) NOT NULL
);
CREATE TABLE dbo.Stock (
    ProductID int PRIMARY KEY REFERENCES dbo.Products(ProductID),
    OnHand int NOT NULL
);
CREATE TABLE dbo.StockMovements (
    MovementID int IDENTITY PRIMARY KEY,
    ProductID int NOT NULL REFERENCES dbo.Products(ProductID),
    Delta int NOT NULL,
    OrderLineID int NULL,
    At datetime2(0) NOT NULL DEFAULT SYSDATETIME()
);
CREATE TABLE dbo.CustomerBalance (
    CustomerID int PRIMARY KEY REFERENCES dbo.Customers(CustomerID),
    Balance decimal(12,2) NOT NULL
);
CREATE TABLE dbo.AuditLog (
    AuditID int IDENTITY PRIMARY KEY,
    TableName sysname NOT NULL,
    KeyValue int NOT NULL,
    OldValue int NULL,
    NewValue int NULL,
    At datetime2(0) NOT NULL DEFAULT SYSDATETIME()
);
GO
-- Second hop: an order line takes the quantity out of the stock and logs the movement.
CREATE TRIGGER dbo.trg_OrderLines_Stock ON dbo.OrderLines AFTER INSERT AS
BEGIN
    SET NOCOUNT ON;
    UPDATE s SET OnHand = s.OnHand - i.Quantity
    FROM dbo.Stock s
    JOIN (SELECT ProductID, SUM(Quantity) AS Quantity FROM inserted GROUP BY ProductID) i ON i.ProductID = s.ProductID;

    INSERT INTO dbo.StockMovements (ProductID, Delta, OrderLineID)
    SELECT ProductID, -Quantity, OrderLineID FROM inserted;
END
GO
-- Third hop: a change of stock is audited. Nothing in usp_PlaceOrder says so.
CREATE TRIGGER dbo.trg_Stock_Audit ON dbo.Stock AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.AuditLog (TableName, KeyValue, OldValue, NewValue)
    SELECT 'Stock', i.ProductID, d.OnHand, i.OnHand
    FROM inserted i
    JOIN deleted d ON d.ProductID = i.ProductID
    WHERE i.OnHand <> d.OnHand;
END
GO
-- Second hop, other branch: the balance of the customer follows the order (a MERGE).
CREATE TRIGGER dbo.trg_Orders_Balance ON dbo.Orders AFTER INSERT AS
BEGIN
    SET NOCOUNT ON;
    MERGE dbo.CustomerBalance AS target
    USING (SELECT CustomerID, SUM(Total) AS Total FROM inserted GROUP BY CustomerID) AS source
        ON target.CustomerID = source.CustomerID
    WHEN MATCHED THEN UPDATE SET Balance = target.Balance + source.Total
    WHEN NOT MATCHED THEN INSERT (CustomerID, Balance) VALUES (source.CustomerID, source.Total);
END
GO
-- The procedure: two tables written, in plain sight.
CREATE PROCEDURE dbo.usp_PlaceOrder @CustomerID int, @ProductID int, @Quantity int AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @OrderID int, @Price decimal(10,2);

    -- A CTE named like a table: it is the CTE, not a second table.
    WITH Products AS (SELECT ProductID, UnitPrice FROM dbo.Products WHERE ProductID = @ProductID)
    SELECT @Price = UnitPrice FROM Products;

    INSERT INTO dbo.Orders (CustomerID, Total) VALUES (@CustomerID, @Price * @Quantity);
    SET @OrderID = SCOPE_IDENTITY();

    INSERT INTO dbo.OrderLines (OrderID, ProductID, Quantity, UnitPrice) VALUES (@OrderID, @ProductID, @Quantity, @Price);
    RETURN @OrderID;
END
GO
-- Names that are only text. A comment is not code: it is ignored. A string may be
-- dynamic SQL: a name in one is listed as "possible", never as a write.
CREATE PROCEDURE dbo.usp_Notes AS
BEGIN
    SET NOCOUNT ON;
    -- DELETE FROM dbo.AuditLog   <- a comment
    SELECT N'see dbo.StockMovements' AS Note;   -- a string
END
GO
-- Dynamic SQL written as a literal: the table can be read in the text.
CREATE PROCEDURE dbo.usp_CloseDay AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @sql nvarchar(max) = N'DELETE FROM dbo.AuditLog WHERE At < DATEADD(day, -30, SYSDATETIME())';
    EXEC sp_executesql @sql;
END
GO
-- Dynamic SQL built at run time: the table is a parameter. No static analysis can
-- know which table this touches, and the tool does not pretend it does.
CREATE PROCEDURE dbo.usp_Purge @Table sysname, @Days int AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @sql nvarchar(max) = N'DELETE FROM dbo.' + QUOTENAME(@Table) + N' WHERE At < DATEADD(day, -@Days, SYSDATETIME())';
    EXEC sp_executesql @sql, N'@Days int', @Days = @Days;
END
GO
CREATE VIEW dbo.vw_OrderTotals AS
SELECT o.OrderID, c.Name AS Customer, o.OrderDate, SUM(l.Quantity * l.UnitPrice) AS Total
FROM dbo.Orders o
JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
JOIN dbo.OrderLines l ON l.OrderID = o.OrderID
GROUP BY o.OrderID, c.Name, o.OrderDate;
GO
INSERT INTO dbo.Customers (Name, Country) VALUES (N'Northwind Traders', 'US'), (N'Contoso', 'FR'), (N'Fabrikam', 'DE');
INSERT INTO dbo.Products (Name, UnitPrice) VALUES (N'Widget', 9.90), (N'Gadget', 24.50), (N'Gizmo', 4.25);
INSERT INTO dbo.Stock (ProductID, OnHand) VALUES (1, 500), (2, 120), (3, 800);
GO
EXEC dbo.usp_PlaceOrder 1, 1, 3;
EXEC dbo.usp_PlaceOrder 2, 2, 1;
GO
