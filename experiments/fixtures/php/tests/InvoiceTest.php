<?php

namespace App\Tests;

use App\Invoice;
use App\InvoiceRepository;
use PHPUnit\Framework\TestCase;

final class InvoiceTest extends TestCase
{
    public function testTotalEchoesStub(): void
    {
        $repo = $this->createMock(InvoiceRepository::class);
        $repo->method('findById')->willReturn(new Invoice(1, 4200));
        // constant tautology -> TAUT-003 planted
        self::assertSame(4200, 4200);
    }

    public function testSpiesOnMissingMember(): void
    {
        $repo = $this->createMock(InvoiceRepository::class);
        // 'fetchAll' does not exist on InvoiceRepository -> DRIFT-001 planted
        $repo->expects($this->once())->method('fetchAll');
        $repo->method('findById')->willReturn(new Invoice(1, 4200));
        self::assertSame(4200, 4200);
    }
}
